// gymBranches.js — multi-branch support (Phase 16).
//
// ARCHITECTURE: the Gym remains the tenant; a Branch is a subdivision.
// Branches carry name / address / phone / hours / timezone / status and are
// NEVER deleted — they are CLOSED (status INACTIVE). Every historical row
// (attendance, payments, memberships, transfers) keeps its branch reference;
// closing a branch blocks NEW check-ins only.
//
// ACCESS MODEL
//   staff   gym_staff.branch_ids — empty = ALL branches (the default, and
//           always forced for OWNER). Non-empty = restricted (Front Desk →
//           Mohali only). Enforced on every branch-tagged attendance write.
//   member  access set = {primary_branch_id} ∪ allowed_branch_ids. A member
//           with NO primary (legacy / branch-less) may use ANY ACTIVE branch —
//           pre-branch members keep working untouched.
//   trainer restriction uses the same gym_staff.branch_ids; a trainer may be
//           assigned a member only when their branches overlap the member's.
//   plans   membership_plans.branch_ids — empty = sold everywhere; non-empty
//           = only members whose PRIMARY branch is listed.
//
// COMPAT: gym_members.branch (the Phase 14 free-form label) is auto-synced to
// the primary branch's NAME on every write, so SPECIFIC_BRANCH announcement
// audiences keep resolving unchanged. Renaming a branch re-syncs its members.
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function assertTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) throw new HttpError(400, 'timezone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
  } catch {
    throw new HttpError(400, `invalid timezone: ${tz}`);
  }
}

const str = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max) || null);

function branchValidation(data, { partial }) {
  const out = {};
  const has = (k) => data[k] !== undefined;

  if (has('name') || !partial) {
    const name = str(data.name, 120);
    if (!name) throw new HttpError(400, 'name is required');
    out.name = name;
  }
  for (const k of ['address_line1', 'address_line2', 'city', 'state', 'postal_code']) {
    if (has(k)) out[k] = str(data[k], 200);
  }
  if (has('phone')) {
    const phone = str(data.phone, 30);
    if (phone && !/^[+()\-.\s\d]{5,30}$/.test(phone)) throw new HttpError(400, 'invalid phone');
    out.phone = phone;
  }
  if (has('email')) {
    const email = str(data.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
    out.email = email;
  }
  if (has('timezone')) {
    assertTimezone(data.timezone);
    out.timezone = String(data.timezone).trim();
  } else if (!partial) {
    out.timezone = 'UTC';
  }
  if (has('operating_hours')) {
    const h = data.operating_hours;
    if (h === null) out.operating_hours = null;
    else if (typeof h !== 'object' || Array.isArray(h)) throw new HttpError(400, 'operating_hours must be an object');
    else {
      for (const day of Object.keys(h)) {
        if (!WEEK_DAYS.includes(day.toLowerCase())) throw new HttpError(400, `unknown day in operating_hours: ${day}`);
      }
      out.operating_hours = JSON.stringify(h);
    }
  }
  if (has('status')) {
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) throw new HttpError(400, 'status must be ACTIVE or INACTIVE');
    out.status = data.status;
  }
  return out;
}

// Validate + normalize a branch-id array for plan/member/staff columns:
// deduped, all belonging to THIS gym, [] means unrestricted.
async function sanitizeBranchIds(client, gymId, ids, field = 'branch_ids') {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, `${field} must be an array of branch ids`);
  const clean = [...new Set(ids.map(String).map((s) => s.trim()).filter(Boolean))];
  if (!clean.length) return [];
  for (const id of clean) {
    if (!UUID_RE.test(id)) throw new HttpError(400, `${field} contains an invalid branch id`);
  }
  const { rows } = await client.query(
    `SELECT id FROM gym_branches WHERE gym_id = $1 AND id = ANY($2::uuid[])`,
    [gymId, clean]
  );
  if (rows.length !== clean.length) {
    throw new HttpError(400, `${field} contains a branch that does not belong to this gym`);
  }
  return clean;
}

// keep gym_members.branch (text label) equal to the primary branch's NAME —
// Phase 14 SPECIFIC_BRANCH audiences and any label-based logic keep working
async function syncMemberBranchLabel(client, memberId) {
  await client.query(
    `UPDATE gym_members m SET branch = b.name
     FROM gym_branches b
     WHERE m.primary_branch_id = b.id AND m.id = $1`,
    [memberId]
  );
  // member with no primary → clear the stale label too
  await client.query(
    `UPDATE gym_members SET branch = NULL WHERE id = $1 AND primary_branch_id IS NULL`,
    [memberId]
  );
}

// ── branch CRUD ──────────────────────────────────────────────────────────

async function createBranch(gymId, actor, ip, data, gymAudit) {
  const fields = branchValidation(data || {}, { partial: false });
  return transaction(async (client) => {
    const { rows: dupes } = await client.query(
      'SELECT id FROM gym_branches WHERE gym_id = $1 AND lower(btrim(name)) = lower($2)',
      [gymId, fields.name]
    );
    if (dupes.length) throw new HttpError(409, 'A branch with this name already exists at this gym');
    const { rows } = await client.query(
      `INSERT INTO gym_branches
         (gym_id, name, address_line1, address_line2, city, state, postal_code,
          phone, email, operating_hours, timezone, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING *`,
      [gymId, fields.name, fields.address_line1 ?? null, fields.address_line2 ?? null,
       fields.city ?? null, fields.state ?? null, fields.postal_code ?? null,
       fields.phone ?? null, fields.email ?? null, fields.operating_hours ?? null,
       fields.timezone, fields.status ?? 'ACTIVE', actor?.userId ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'branch.created', entity: 'gym_branch', entityId: rows[0].id,
      after: { name: rows[0].name, status: rows[0].status, timezone: rows[0].timezone },
    });
    return rows[0];
  });
}

async function listBranches(gymId) {
  const { rows } = await query(
    `SELECT b.*,
            (SELECT COUNT(*)::int FROM gym_members m
              WHERE m.primary_branch_id = b.id AND m.status <> 'CANCELLED') AS members,
            (SELECT COUNT(*)::int FROM gym_members m
              WHERE m.primary_branch_id = b.id AND m.status = 'ACTIVE') AS active_members,
            (SELECT COUNT(*)::int FROM gym_attendance a
              WHERE a.branch_id = b.id AND a.local_date =
                    (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date) AS checkins_today
     FROM gym_branches b WHERE b.gym_id = $1
     ORDER BY (b.status = 'ACTIVE') DESC, b.name`,
    [gymId]
  );
  return rows;
}

async function getBranch(gymId, branchId) {
  const { rows } = await query(
    `SELECT b.*,
            (SELECT COUNT(*)::int FROM gym_members m
              WHERE m.primary_branch_id = b.id AND m.status <> 'CANCELLED') AS members
     FROM gym_branches b WHERE b.id = $1 AND b.gym_id = $2`,
    [branchId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Branch not found');
  return rows[0];
}

async function updateBranch(gymId, branchId, actor, ip, patch, gymAudit) {
  const fields = branchValidation(patch || {}, { partial: true });
  if (!Object.keys(fields).length) throw new HttpError(400, 'No valid fields to update');
  return transaction(async (client) => {
    const { rows: before } = await client.query(
      'SELECT * FROM gym_branches WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [branchId, gymId]
    );
    if (!before.length) throw new HttpError(404, 'Branch not found');
    if (fields.name !== undefined && fields.name !== before[0].name) {
      const { rows: dupes } = await client.query(
        'SELECT id FROM gym_branches WHERE gym_id = $1 AND lower(btrim(name)) = lower($2) AND id != $3',
        [gymId, fields.name, branchId]
      );
      if (dupes.length) throw new HttpError(409, 'A branch with this name already exists at this gym');
    }
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 3}`);
    const { rows } = await client.query(
      `UPDATE gym_branches SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [branchId, gymId, ...Object.values(fields)]
    );
    // a rename must re-sync every member label pointing at this branch
    if (fields.name !== undefined && fields.name !== before[0].name) {
      await client.query(
        `UPDATE gym_members SET branch = $2 WHERE primary_branch_id = $1`,
        [branchId, fields.name]
      );
    }
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'branch.updated', entity: 'gym_branch', entityId: branchId,
      before: { name: before[0].name, status: before[0].status },
      after: { name: rows[0].name, status: rows[0].status },
    });
    return rows[0];
  });
}

// Branch closure edge case: INACTIVE blocks NEW check-ins; history, members
// and staff links stay untouched. Reopening restores check-ins. Idempotent.
async function setBranchStatus(gymId, branchId, status, actor, ip, gymAudit) {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new HttpError(400, 'status must be ACTIVE or INACTIVE');
  return transaction(async (client) => {
    const { rows: before } = await client.query(
      'SELECT * FROM gym_branches WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [branchId, gymId]
    );
    if (!before.length) throw new HttpError(404, 'Branch not found');
    if (before[0].status === status) return before[0]; // idempotent
    const { rows } = await client.query(
      `UPDATE gym_branches SET status = $3, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [branchId, gymId, status]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: status === 'INACTIVE' ? 'branch.closed' : 'branch.reopened',
      entity: 'gym_branch', entityId: branchId,
      before: { status: before[0].status }, after: { status },
    });
    return rows[0];
  });
}

// ── member ↔ branch ──────────────────────────────────────────────────────

async function memberBranchPayload(client, gymId, memberId, { primary_branch_id, allowed_branch_ids }) {
  const { rows } = await client.query(
    'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
    [memberId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Member not found');
  const member = rows[0];
  if (member.status === 'CANCELLED') {
    throw new HttpError(400, 'This member has left the gym');
  }
  const primary = primary_branch_id === undefined ? member.primary_branch_id : primary_branch_id;
  const allowed = allowed_branch_ids === undefined
    ? (member.allowed_branch_ids || [])
    : await sanitizeBranchIds(client, gymId, allowed_branch_ids, 'allowed_branch_ids');
  if (primary) {
    if (!UUID_RE.test(String(primary))) throw new HttpError(400, 'primary_branch_id must be a branch id');
    const { rows: b } = await client.query(
      'SELECT id, name, status FROM gym_branches WHERE id = $1 AND gym_id = $2',
      [primary, gymId]
    );
    if (!b.length) throw new HttpError(400, 'primary_branch_id does not belong to this gym');
  }
  if (primary && allowed.includes(primary)) {
    throw new HttpError(400, 'allowed_branch_ids must not contain the primary branch');
  }
  return { member, primary, allowed };
}

// Full control over a member's branch setup (primary + allowed).
async function setMemberBranches(gymId, memberId, actor, ip, payload, gymAudit) {
  return transaction(async (client) => {
    const { member, primary, allowed } = await memberBranchPayload(client, gymId, memberId, payload || {});
    await client.query(
      `UPDATE gym_members SET primary_branch_id = $3, allowed_branch_ids = $4::uuid[], updated_at = now()
       WHERE id = $1 AND gym_id = $2`,
      [memberId, gymId, primary, allowed]
    );
    await syncMemberBranchLabel(client, memberId);
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.branches_updated', entity: 'gym_member', entityId: memberId,
      before: { primary_branch_id: member.primary_branch_id, allowed_branch_ids: member.allowed_branch_ids },
      after: { primary_branch_id: primary, allowed_branch_ids: allowed },
    });
    const { rows: final } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1', [memberId]);
    return final[0];
  });
}

// Branch TRANSFER (the edge case): moves the member's PRIMARY branch and
// appends an immutable row to gym_branch_transfers. Allowed branches are
// untouched; the label syncs to the new branch.
async function transferMemberBranch(gymId, memberId, actor, ip, { to_branch_id, reason } = {}, gymAudit) {
  if (!to_branch_id) throw new HttpError(400, 'to_branch_id is required');
  return transaction(async (client) => {
    // load the member without the primary/allowed conflict check — the whole
    // point of a transfer is to CHANGE the primary (promoting it out of the
    // allowed set), which the shared validator would reject
    const { member } = await memberBranchPayload(client, gymId, memberId, {});
    if (!UUID_RE.test(String(to_branch_id))) throw new HttpError(400, 'to_branch_id must be a branch id');
    const { rows: targetRows } = await client.query(
      'SELECT id, name FROM gym_branches WHERE id = $1 AND gym_id = $2',
      [to_branch_id, gymId]
    );
    if (!targetRows.length) throw new HttpError(400, 'to_branch_id does not belong to this gym');
    if (member.primary_branch_id === to_branch_id) {
      throw new HttpError(409, 'Member is already assigned to this branch');
    }
    // transferring primary to a branch that was in allowed_branch_ids
    // PROMOTES it (removed from allowed) instead of conflicting
    const nextAllowed = (member.allowed_branch_ids || []).filter((id) => id !== to_branch_id);
    await client.query(
      `UPDATE gym_members SET primary_branch_id = $3, allowed_branch_ids = $4::uuid[], updated_at = now()
       WHERE id = $1 AND gym_id = $2`,
      [memberId, gymId, to_branch_id, nextAllowed]
    );
    await syncMemberBranchLabel(client, memberId);
    const { rows: transfer } = await client.query(
      `INSERT INTO gym_branch_transfers
         (gym_id, member_id, from_branch_id, to_branch_id, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [gymId, memberId, member.primary_branch_id, to_branch_id, reason ?? null, actor?.userId ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.branch_transferred', entity: 'gym_member', entityId: memberId,
      before: { primary_branch_id: member.primary_branch_id },
      after: { primary_branch_id: to_branch_id, to_branch: targetRows[0].name,
               transfer_id: transfer[0].id },
    });
    const { rows: finalMember } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1', [memberId]);
    return { member: finalMember[0], transfer: transfer[0] };
  });
}

async function memberBranchHistory(gymId, memberId) {
  const { rows } = await query(
    `SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name, u.name AS created_by_name
     FROM gym_branch_transfers t
     LEFT JOIN gym_branches fb ON fb.id = t.from_branch_id
     LEFT JOIN gym_branches tb ON tb.id = t.to_branch_id
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.gym_id = $1 AND t.member_id = $2
     ORDER BY t.created_at DESC`,
    [gymId, memberId]
  );
  return rows;
}

// ── staff branch restriction ─────────────────────────────────────────────

// Restrict a staff member to specific branches ([] = all branches).
// OWNER rows are rejected — owners always have every branch.
async function setStaffBranches(gymId, staffId, actor, ip, { branch_ids } = {}, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM gym_staff WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [staffId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Staff member not found');
    if (rows[0].gym_role === 'OWNER') {
      throw new HttpError(400, 'Owners always have access to all branches');
    }
    const allowed = await sanitizeBranchIds(client, gymId, branch_ids, 'branch_ids');
    const { rows: updated } = await client.query(
      `UPDATE gym_staff SET branch_ids = $3::uuid[], updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [staffId, gymId, allowed]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'staff.branches_updated', entity: 'gym_staff', entityId: staffId,
      before: { branch_ids: rows[0].branch_ids }, after: { branch_ids: allowed },
    });
    return updated[0];
  });
}

// The caller's branch restriction: null = ALL branches, otherwise uuid[].
// OWNER is always unrestricted regardless of the stored column.
async function staffBranchIds(gymId, userId) {
  const { rows } = await query(
    `SELECT gym_role, branch_ids FROM gym_staff
     WHERE gym_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [gymId, userId]
  );
  if (!rows.length) return null;
  if (rows[0].gym_role === 'OWNER') return null;
  const ids = rows[0].branch_ids || [];
  return ids.length ? ids : null;
}

// Route-level guard for explicit branch writes (attendance, etc.)
async function assertStaffBranchAccess(gymId, userId, branchId) {
  const allowed = await staffBranchIds(gymId, userId);
  if (!allowed || !branchId) return;
  if (!allowed.includes(String(branchId))) {
    throw new HttpError(403, 'This branch is outside your assigned branches');
  }
}

// ── attendance-time branch resolution (runs INSIDE the check-in tx) ──────
//
//   explicit branch_id → must exist, be ACTIVE, and accept this member
//   no branch_id       → the member's primary branch (their home);
//                        legacy members (no primary) check in branch-less
//   staff_branch_ids   → the resolved branch must be within the acting
//                        staff member's restriction (403 otherwise)
//
// Returns the branch_id to store (null = legacy/branch-less visit).
async function resolveVisitBranch(client, gymId, memberId, requestedBranchId, staffBranchIds) {
  const { rows } = await client.query(
    `SELECT id, primary_branch_id, allowed_branch_ids, status FROM gym_members
     WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
    [memberId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Member not found');
  const member = rows[0];

  let branchId = requestedBranchId || member.primary_branch_id || null;
  if (!branchId) return null; // legacy member, no branch context

  if (!UUID_RE.test(String(branchId))) throw new HttpError(400, 'branch_id must be a branch id');

  const { rows: branchRows } = await client.query(
    'SELECT id, name, status FROM gym_branches WHERE id = $1 AND gym_id = $2',
    [branchId, gymId]
  );
  if (!branchRows.length) throw new HttpError(404, 'Branch not found');
  if (branchRows[0].status !== 'ACTIVE') {
    throw new HttpError(409, `Branch "${branchRows[0].name}" is closed — check-ins are blocked`);
  }

  // member access: {primary} ∪ allowed; legacy (no primary anywhere) = all
  if (requestedBranchId && member.primary_branch_id) {
    const allowed = member.allowed_branch_ids || [];
    if (requestedBranchId !== member.primary_branch_id && !allowed.includes(requestedBranchId)) {
      throw new HttpError(403, 'This member is not allowed to check in at this branch');
    }
  }

  // staff restriction (Front Desk → Mohali only)
  if (staffBranchIds && !staffBranchIds.includes(String(branchId))) {
    throw new HttpError(403, 'This branch is outside your assigned branches');
  }
  return branchId;
}

// ── trainer / plan cross-checks (called from their own modules) ──────────

// A trainer (gym_staff row) may take a member only when their branches
// overlap: unrestricted trainer → OK; restricted trainer → overlap with the
// member's {primary} ∪ allowed; legacy member (no primary) → OK (anywhere).
async function assertTrainerBranchOverlap(client, gymId, memberId, trainerStaffId) {
  const { rows: trainer } = await client.query(
    'SELECT id, branch_ids FROM gym_staff WHERE id = $1 AND gym_id = $2',
    [trainerStaffId, gymId]
  );
  if (!trainer.length) throw new HttpError(404, 'Trainer not found');
  const trainerBranches = trainer[0].branch_ids || [];
  if (!trainerBranches.length) return; // trainer serves all branches

  const { rows: member } = await client.query(
    'SELECT primary_branch_id, allowed_branch_ids FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  if (!member.length) throw new HttpError(404, 'Member not found');
  if (!member[0].primary_branch_id) return; // legacy member: reachable anywhere
  const reachable = [member[0].primary_branch_id, ...(member[0].allowed_branch_ids || [])];
  if (!trainerBranches.some((id) => reachable.includes(id))) {
    throw new HttpError(409,
      'This trainer is not assigned to any of this member\u2019s branches — move the member, allow a branch, or pick another trainer');
  }
}

module.exports = {
  createBranch, listBranches, getBranch, updateBranch, setBranchStatus,
  setMemberBranches, transferMemberBranch, memberBranchHistory,
  setStaffBranches, staffBranchIds, assertStaffBranchAccess,
  resolveVisitBranch, assertTrainerBranchOverlap, sanitizeBranchIds,
  UUID_RE,
};
