// gyms.js — data access for the Gym Management System foundation:
// gyms, staff (gym-scoped roles), members (no app account required),
// app-account linking, and the audit log.
//
// RULES (GYM_MANAGEMENT_DESIGN.md):
//  - users is the global identity; User.gymId is forbidden. Relationships
//    live in gym_staff / gym_members.
//  - A gym member does NOT need an app account (app_user_id NULL).
//  - Linking is by exact verified email and never duplicates a member row
//    or a user account.
//  - Every mutation writes an audit_logs row in the same transaction.
//  - The last ACTIVE OWNER of a gym can never be demoted/removed.
const { pool, query, transaction } = require('../db/pool');
const { hasPermission } = require('./gymPermissions');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'gym';

const GYM_ROLES = ['OWNER', 'ADMIN', 'TRAINER', 'FRONT_DESK', 'MEMBER'];
const STAFF_STATUSES = ['ACTIVE', 'INACTIVE', 'REMOVED'];
const MEMBER_STATUSES = ['ACTIVE', 'PENDING', 'FROZEN', 'EXPIRED', 'CANCELLED'];

// ── audit ────────────────────────────────────────────────────────────────
async function gymAudit(client, { gymId, actorUserId, actorLabel, action, entity, entityId, before, after, ip }) {
  await client.query(
    `INSERT INTO audit_logs (gym_id, actor_user_id, actor_label, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [gymId ?? null, actorUserId ?? null, actorLabel ?? null, action, entity,
     entityId != null ? String(entityId) : null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
     ip ?? null]
  );
}

// ── gyms ─────────────────────────────────────────────────────────────────

// Create a gym: caller becomes its OWNER. If the caller is a plain app user,
// users.role upgrades to 'gym_staff' so login routes them to the portal.
// A trainer keeps role 'trainer' (global role untouched — the gym role is
// decided by gym_staff alone).
async function createGym(userId, ip, { name, timezone, currency, address_line1, address_line2, city, state, postal_code, phone, email }) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 120) throw new HttpError(400, 'name is required (max 120 characters)');
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter code');
  return transaction(async (client) => {
    const slug = `${slugify(trimmed)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { rows: gymRows } = await client.query(
      `INSERT INTO gyms (name, slug, timezone, currency, address_line1, address_line2, city, state, postal_code, phone, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [trimmed, slug, timezone || 'UTC', currency || 'INR',
       address_line1 ?? null, address_line2 ?? null, city ?? null, state ?? null,
       postal_code ?? null, phone ?? null, email ?? null]
    );
    const gym = gymRows[0];
    await client.query(
      `INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1,$2,'OWNER')`,
      [gym.id, userId]
    );
    const { rows: userRows } = await client.query(
      `UPDATE users SET role = 'gym_staff', updated_at = now()
       WHERE id = $1 AND role = 'user' RETURNING id, role`,
      [userId]
    );
    await gymAudit(client, {
      gymId: gym.id, actorUserId: userId, ip,
      action: 'gym.created', entity: 'gym', entityId: gym.id, after: { name: gym.name },
    });
    return { gym, membershipRole: userRows[0]?.role || null };
  });
}

async function listGymsForStaff(userId) {
  const { rows } = await query(
    `SELECT g.id, g.name, g.slug, g.status, s.gym_role, s.status AS staff_status, s.created_at AS staff_since
     FROM gym_staff s JOIN gyms g ON g.id = s.gym_id
     WHERE s.user_id = $1 AND s.status = 'ACTIVE' AND g.status = 'ACTIVE'
     ORDER BY g.name`,
    [userId]
  );
  return rows;
}

async function getGymById(gymId) {
  const { rows } = await query('SELECT * FROM gyms WHERE id = $1', [gymId]);
  return rows[0] || null;
}

async function updateGym(gymId, actor, patch, ip) {
  const allowed = ['name', 'timezone', 'currency', 'address_line1', 'address_line2',
    'city', 'state', 'postal_code', 'phone', 'email', 'settings'];
  const sets = [];
  const vals = [gymId];
  const before = await getGymById(gymId);
  if (!before) throw new HttpError(404, 'Gym not found');
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k) || v === undefined) continue;
    if (k === 'name' && (!String(v).trim() || String(v).length > 120)) {
      throw new HttpError(400, 'name is required (max 120 characters)');
    }
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No valid fields to update');
  const { rows } = await query(
    `UPDATE gyms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals
  );
  await gymAudit(pool, {
    gymId, actorUserId: actor, ip,
    action: 'gym.updated', entity: 'gym', entityId: gymId, before, after: rows[0],
  });
  return rows[0];
}

// ── staff ────────────────────────────────────────────────────────────────

async function listGymStaff(gymId) {
  const { rows } = await query(
    `SELECT s.id, s.gym_role, s.status, s.created_at, u.name, u.email
     FROM gym_staff s JOIN users u ON u.id = s.user_id
     WHERE s.gym_id = $1 AND s.status != 'REMOVED'
     ORDER BY s.created_at`,
    [gymId]
  );
  return rows;
}

async function countActiveOwners(client, gymId, excludeStaffId = null) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM gym_staff
     WHERE gym_id = $1 AND gym_role = 'OWNER' AND status = 'ACTIVE' AND id != $2`,
    [gymId, excludeStaffId ?? null]
  );
  return rows[0].c;
}

// Add staff by EMAIL — the person must already have an app account (staff
// authenticate through `users`). No user row is created here.
async function addGymStaff(gymId, actor, ip, { email, gym_role }) {
  if (!GYM_ROLES.includes(gym_role) || gym_role === 'MEMBER') {
    throw new HttpError(400, 'gym_role must be one of OWNER, ADMIN, TRAINER, FRONT_DESK');
  }
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) throw new HttpError(400, 'email is required');
  const { rows: users } = await query(
    'SELECT id, name, email, role FROM users WHERE lower(email) = $1',
    [emailNorm]
  );
  if (!users.length) throw new HttpError(404, 'No app account with that email. The person must sign up first.');
  const user = users[0];
  return transaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id, status FROM gym_staff WHERE gym_id = $1 AND user_id = $2`,
      [gymId, user.id]
    );
    if (existing.length) {
      if (existing[0].status === 'ACTIVE') throw new HttpError(409, 'This user is already staff at this gym');
      // re-hire a previously removed/inactive staff member
      const { rows: rehired } = await client.query(
        `UPDATE gym_staff SET gym_role = $3, status = 'ACTIVE', updated_at = now()
         WHERE id = $1 AND gym_id = $2 RETURNING *`,
        [existing[0].id, gymId, gym_role]
      );
      await gymAudit(client, {
        gymId, actorUserId: actor, ip, action: 'staff.rehired',
        entity: 'gym_staff', entityId: existing[0].id, after: { gym_role, user: user.email },
      });
      return rehired[0];
    }
    const { rows: inserted } = await client.query(
      `INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1,$2,$3) RETURNING *`,
      [gymId, user.id, gym_role]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor, ip, action: 'staff.added',
      entity: 'gym_staff', entityId: inserted[0].id, after: { gym_role, user: user.email },
    });
    return inserted[0];
  });
}

// Change a staff member's role or status. The last ACTIVE OWNER can never be
// demoted/removed — ownership transfer must happen first.
async function updateGymStaff(gymId, staffId, actor, ip, { gym_role, status }) {
  if (gym_role !== undefined && !GYM_ROLES.includes(gym_role)) {
    throw new HttpError(400, 'invalid gym_role');
  }
  if (status !== undefined && !STAFF_STATUSES.includes(status)) {
    throw new HttpError(400, 'invalid status');
  }
  return transaction(async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM gym_staff WHERE id = $1 AND gym_id = $2`,
      [staffId, gymId]
    );
    if (!currentRows.length) throw new HttpError(404, 'Staff not found');
    const current = currentRows[0];
    const willLoseOwner =
      current.gym_role === 'OWNER' &&
      ((gym_role !== undefined && gym_role !== 'OWNER') ||
       (status !== undefined && status !== 'ACTIVE'));
    if (willLoseOwner && (await countActiveOwners(client, gymId, staffId)) === 0) {
      throw new HttpError(400, 'Cannot demote or remove the last active owner. Transfer ownership first.');
    }
    const { rows } = await client.query(
      `UPDATE gym_staff SET
         gym_role = COALESCE($3, gym_role),
         status = COALESCE($4, status),
         updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [staffId, gymId, gym_role ?? null, status ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor, ip, action: 'staff.updated',
      entity: 'gym_staff', entityId: staffId,
      before: { gym_role: current.gym_role, status: current.status },
      after: { gym_role: rows[0].gym_role, status: rows[0].status },
    });
    return rows[0];
  });
}

// ── members ──────────────────────────────────────────────────────────────

function memberCreateValidation(data) {
  const first = String(data.first_name || '').trim();
  if (!first || first.length > 80) throw new HttpError(400, 'first_name is required (max 80 characters)');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new HttpError(400, 'invalid email');
  }
  if (data.status && !MEMBER_STATUSES.includes(data.status)) throw new HttpError(400, 'invalid status');
}

async function createGymMember(gymId, actor, ip, data) {
  memberCreateValidation(data);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO gym_members
         (gym_id, first_name, last_name, email, phone, status, notes, joined_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE))
       RETURNING *`,
      [gymId, String(data.first_name).trim(), data.last_name ?? null,
       data.email ?? null, data.phone ?? null,
       data.status || 'ACTIVE', data.notes ?? null, data.joined_at ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.created', entity: 'gym_member', entityId: rows[0].id,
      after: { name: rows[0].first_name, email: rows[0].email, status: rows[0].status },
    });
    return rows[0];
  });
}

async function listGymMembers(gymId, { status, q, limit = 50, offset = 0 }) {
  const vals = [gymId];
  const where = ['gym_id = $1'];
  if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(first_name ILIKE $${vals.length} OR last_name ILIKE $${vals.length}
                 OR email ILIKE $${vals.length} OR member_code ILIKE $${vals.length}
                 OR phone ILIKE $${vals.length})`);
  }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 50, 200)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT * FROM gym_members WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows;
}

async function getGymMember(gymId, memberId) {
  const { rows } = await query(
    'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  return rows[0] || null;
}

async function updateGymMember(gymId, memberId, actor, ip, patch) {
  const allowed = ['first_name', 'last_name', 'email', 'phone', 'status', 'notes', 'joined_at'];
  const sets = [];
  const vals = [memberId, gymId];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k) || v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No valid fields to update');
  return transaction(async (client) => {
    const { rows: beforeRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2', [memberId, gymId]
    );
    if (!beforeRows.length) throw new HttpError(404, 'Member not found');
    memberCreateValidation({ ...beforeRows[0], ...patch });
    const { rows } = await client.query(
      `UPDATE gym_members SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      vals
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.updated', entity: 'gym_member', entityId: memberId,
      before: { status: beforeRows[0].status, email: beforeRows[0].email },
      after: { status: rows[0].status, email: rows[0].email },
    });
    return rows[0];
  });
}

// ── app-account linking ──────────────────────────────────────────────────

// Link an existing GymMember to an app account by EXACT email match. The
// member row is UPDATED (never duplicated) and the user account is never
// created or modified here. Guarded by the partial-unique index so two
// ACTIVE members in the same gym can never share one app account.
async function linkMemberToApp(gymId, memberId, actor, ip, { email }) {
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) throw new HttpError(400, 'email is required');
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const member = memberRows[0];
    const { rows: users } = await client.query(
      'SELECT id, name, email FROM users WHERE lower(email) = $1',
      [emailNorm]
    );
    if (!users.length) throw new HttpError(404, 'No app account with that email');
    const user = users[0];
    const { rows: clash } = await client.query(
      `SELECT id FROM gym_members
       WHERE gym_id = $1 AND app_user_id = $2 AND id != $3
         AND status IN ('ACTIVE','PENDING','FROZEN')`,
      [gymId, user.id, member.id]
    );
    if (clash.length) {
      throw new HttpError(409, 'That app account is already linked to another member of this gym');
    }
    const { rows } = await client.query(
      `UPDATE gym_members SET app_user_id = $3, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [member.id, gymId, user.id]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.linked_app', entity: 'gym_member', entityId: member.id,
      before: { app_user_id: member.app_user_id },
      after: { app_user_id: user.id, user_email: user.email },
    });
    return rows[0];
  });
}

async function unlinkMemberFromApp(gymId, memberId, actor, ip) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].app_user_id == null) return memberRows[0];
    const before = { app_user_id: memberRows[0].app_user_id };
    const { rows } = await client.query(
      `UPDATE gym_members SET app_user_id = NULL, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [memberId, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.unlinked_app', entity: 'gym_member', entityId: memberId,
      before, after: { app_user_id: null },
    });
    return rows[0];
  });
}

// Gym-member view (app-linked): the gyms/memberships this user belongs to.
async function listGymMembershipsForUser(userId) {
  const { rows } = await query(
    `SELECT m.id, m.member_code, m.status, m.joined_at,
            g.id AS gym_id, g.name AS gym_name, g.slug AS gym_slug
     FROM gym_members m JOIN gyms g ON g.id = m.gym_id
     WHERE m.app_user_id = $1 AND m.status IN ('ACTIVE','PENDING','FROZEN')
     ORDER BY g.name`,
    [userId]
  );
  return rows;
}

// ── audit read ───────────────────────────────────────────────────────────
async function listAuditLog(gymId, { limit = 100, offset = 0, action } = {}) {
  const vals = [gymId];
  const where = ['gym_id = $1'];
  if (action) { vals.push(action); where.push(`action = $${vals.length}`); }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 100, 500)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows;
}

module.exports = {
  GYM_ROLES,
  createGym, listGymsForStaff, getGymById, updateGym,
  listGymStaff, addGymStaff, updateGymStaff,
  createGymMember, listGymMembers, getGymMember, updateGymMember,
  linkMemberToApp, unlinkMemberFromApp, listGymMembershipsForUser,
  listAuditLog, gymAudit,
};
