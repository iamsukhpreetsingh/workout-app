// gymContentAssignments.js — Phase 13: ONE assignment system for ALL
// gym-owned content (WORKOUT | NUTRITION).
//
// RULES:
//  - Unified table gym_content_assignments (migration 054) replaced the
//    per-domain Phase 11/12 tables. gymWorkouts.js / gymNutrition.js
//    delegate their legacy assignment functions here.
//  - Direct assignment payload: member + content + starts_on (default:
//    today in the GYM'S timezone) + optional ends_on (inclusive) + notes.
//  - NON-APP MEMBERS ARE FIRST-CLASS: assignments reference gym_members,
//    app_user_id NULL fully valid — stored until the member connects.
//  - EFFECTIVE STATUS is computed, never stored: ENDED (manually ended),
//    SCHEDULED (starts_on in the future), EXPIRED (ends_on in the past),
//    else ACTIVE. No cron. Expiry therefore cannot be forgotten.
//  - DUPLICATES: at most one non-expired ACTIVE assignment per
//    (member, content) — DB partial unique index + in-code classification.
//    Assigning over an in-window or future row → 409; over an EXPIRED row
//    → the expired row is superseded (ENDED 'superseded') and the new row
//    is inserted, so renewals never need manual cleanup.
//  - CONTENT GUARDS: DRAFT content cannot be assigned (400), ARCHIVED
//    cannot be newly assigned (409). Archived content keeps existing
//    assignments but member surfaces only ever render PUBLISHED content,
//    so archiving hides it reversibly. Content is never hard-deleted via
//    the API; if it ever is, ON DELETE CASCADE removes its assignments.
//  - VERSION TRACKING: assigned_version stamps the content version at
//    assignment time; lists expose content_updated = current version >
//    assigned_version ("content changed after assignment").
//  - TRAINER SCOPING: a TRAINER may only assign/update/end for members on
//    their ACTIVE roster (gym_trainer_assignments); losing that
//    assignment immediately revokes the ability. OWNER/ADMIN (members.manage)
//    and TRAINER (assignments.manage) reach these routes; the check here is
//    the authoritative scope enforcement, not frontend hiding.
//  - MEMBER LEAVES: assignment rows survive a member going CANCELLED (new
//    assignments are blocked until reactivation); the member-facing
//    aggregation only serves rows for ACTIVE members of ACTIVE gyms, so
//    reactivation restores everything untouched.
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTENT_TYPES = ['WORKOUT', 'NUTRITION'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTES = 1000;

// ── small helpers ────────────────────────────────────────────────────────

// strict YYYY-MM-DD + real calendar date (no 2026-02-31)
function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanNotes(notes) {
  if (notes == null || notes === '') return null;
  const s = String(notes).trim();
  if (!s) return null;
  if (s.length > MAX_NOTES) throw new HttpError(400, `notes must be at most ${MAX_NOTES} characters`);
  return s;
}

// "today" as a calendar date in the GYM's timezone — assignment windows are
// gym-local, never server-UTC
async function gymToday(client, gymId) {
  const { rows } = await client.query(
    `SELECT (now() AT TIME ZONE g.timezone)::date::text AS today FROM gyms g WHERE g.id = $1`,
    [gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Gym not found');
  return rows[0].today;
}

function validateWindow(startsOn, endsOn) {
  if (!isRealDate(startsOn)) throw new HttpError(400, 'starts_on must be a valid date (YYYY-MM-DD)');
  if (endsOn != null && !isRealDate(endsOn)) throw new HttpError(400, 'ends_on must be a valid date (YYYY-MM-DD)');
  if (endsOn != null && endsOn < startsOn) {
    throw new HttpError(400, 'ends_on must be on or after starts_on');
  }
}

// effective status from a physical row + the gym-local today
function effectiveStatus(row, today) {
  if (row.status === 'ENDED') return 'ENDED';
  const starts = typeof row.starts_on === 'string' ? row.starts_on : String(row.starts_on).slice(0, 10);
  const ends = row.ends_on == null ? null : (typeof row.ends_on === 'string' ? row.ends_on : String(row.ends_on).slice(0, 10));
  if (starts > today) return 'SCHEDULED';
  if (ends != null && ends < today) return 'EXPIRED';
  return 'ACTIVE';
}

// load the assigned content (id/title/status/version[/kind]) inside a tx
async function loadContent(client, gymId, contentType, contentId) {
  if (contentType === 'WORKOUT') {
    const { rows } = await client.query(
      'SELECT id, title, status, version FROM gym_workouts WHERE id = $1 AND gym_id = $2',
      [contentId, gymId]
    );
    return rows[0] || null;
  }
  const { rows } = await client.query(
    'SELECT id, title, kind, status, version FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2',
    [contentId, gymId]
  );
  return rows[0] || null;
}

const CONTENT_NOUN = {
  WORKOUT: { idCol: 'workout_id', label: 'workout', published: 'Publish the workout before assigning it', archived: 'Archived workouts cannot be assigned to members', dup: 'This workout is already assigned to this member' },
  NUTRITION: { idCol: 'item_id', label: 'nutrition item', published: 'Publish the nutrition item before assigning it', archived: 'Archived nutrition items cannot be assigned to members', dup: 'This nutrition item is already assigned to this member' },
};

// ── trainer scoping ──────────────────────────────────────────────────────

// A TRAINER may only touch members on their ACTIVE roster. OWNER/ADMIN
// (members.manage) are gym-wide. Throws 403 when a trainer reaches outside
// their roster — identical for "member not yours" and "no such member".
async function assertCanManageMember(gymId, ctx, memberId) {
  if (!ctx || ctx.gymRole !== 'TRAINER') return;
  const { rows } = await query(
    `SELECT 1 FROM gym_trainer_assignments
     WHERE gym_id = $1 AND trainer_staff_id = $2 AND member_id = $3 AND status = 'ACTIVE'`,
    [gymId, ctx.staffId, memberId]
  );
  if (!rows.length) {
    throw new HttpError(403, 'Trainers can only manage assignments for members assigned to them');
  }
}

// ── unified row projection (shared by every list) ────────────────────────
// Compat note: emits BOTH the unified names (content_type/content_title/
// effective_status) and the Phase 11/12 names (workout_title, item_title,
// difficulty, goal, item_kind …) so the legacy member-tab endpoints keep
// their exact response shape.
function baseSelect() {
  return `
    SELECT a.id, a.gym_id, a.content_type, a.workout_id, a.item_id, a.member_id,
           a.status, a.starts_on::text AS starts_on, a.ends_on::text AS ends_on,
           a.notes, a.assigned_version, a.end_reason, a.ended_on::text AS ended_on,
           a.assigned_by, a.created_at, a.updated_at,
           CASE WHEN a.status = 'ENDED' THEN 'ENDED'
                WHEN a.starts_on > (now() AT TIME ZONE g.timezone)::date THEN 'SCHEDULED'
                WHEN a.ends_on IS NOT NULL
                 AND a.ends_on < (now() AT TIME ZONE g.timezone)::date THEN 'EXPIRED'
                ELSE 'ACTIVE' END AS effective_status,
           CASE WHEN (a.content_type = 'WORKOUT' AND w.version > a.assigned_version)
                 OR (a.content_type = 'NUTRITION' AND n.version > a.assigned_version)
                THEN true ELSE false END AS content_updated,
           gm.first_name, gm.last_name, gm.member_code, gm.app_user_id,
           gm.status AS member_status,
           u.name AS assigned_by_name,
           w.title AS workout_title, w.version AS workout_version,
           w.status AS workout_status, w.difficulty, w.goal,
           n.title AS item_title, n.kind AS item_kind,
           n.version AS item_version, n.status AS item_status,
           CASE a.content_type WHEN 'WORKOUT' THEN w.title ELSE n.title END AS content_title
    FROM gym_content_assignments a
    JOIN gym_members gm ON gm.id = a.member_id
    JOIN gyms g ON g.id = a.gym_id
    LEFT JOIN users u ON u.id = a.assigned_by
    LEFT JOIN gym_workouts w ON a.content_type = 'WORKOUT' AND w.id = a.workout_id
    LEFT JOIN gym_nutrition_items n ON a.content_type = 'NUTRITION' AND n.id = a.item_id`;
}

// ── create ───────────────────────────────────────────────────────────────

async function assignContent(gymId, memberId, actor, ip, payload = {}, gymAudit, ctx) {
  const { content_type, workout_id, item_id, starts_on, ends_on, notes } = payload;
  if (!CONTENT_TYPES.includes(content_type)) {
    throw new HttpError(400, 'content_type must be WORKOUT or NUTRITION');
  }
  const noun = CONTENT_NOUN[content_type];
  const contentId = content_type === 'WORKOUT' ? workout_id : item_id;
  if (!contentId) throw new HttpError(400, `${noun.idCol} is required for ${content_type}`);
  const clean = cleanNotes(notes);

  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT id, status FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].status === 'CANCELLED') {
      throw new HttpError(400, 'This member has left the gym — reactivate them first');
    }
    // authoritative trainer scope check (inside the tx, after member lock)
    if (ctx && ctx.gymRole === 'TRAINER') {
      const { rows: roster } = await client.query(
        `SELECT 1 FROM gym_trainer_assignments
         WHERE gym_id = $1 AND trainer_staff_id = $2 AND member_id = $3 AND status = 'ACTIVE'`,
        [gymId, ctx.staffId, memberId]
      );
      if (!roster.length) {
        throw new HttpError(403, 'Trainers can only manage assignments for members assigned to them');
      }
    }

    const content = await loadContent(client, gymId, content_type, contentId);
    if (!content) throw new HttpError(404, `${content_type === 'WORKOUT' ? 'Workout' : 'Nutrition item'} not found`);
    if (content.status === 'DRAFT') throw new HttpError(400, noun.published);
    if (content.status === 'ARCHIVED') throw new HttpError(409, noun.archived);

    const today = await gymToday(client, gymId);
    const start = starts_on == null || starts_on === '' ? today : String(starts_on).slice(0, 10);
    const end = ends_on == null || ends_on === '' ? null : String(ends_on).slice(0, 10);
    validateWindow(start, end);

    // duplicate handling over any physically-ACTIVE row for this pair
    const { rows: actives } = await client.query(
      `SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on
       FROM gym_content_assignments
       WHERE member_id = $1 AND content_type = $2
         AND COALESCE(workout_id, item_id) = $3 AND status = 'ACTIVE'`,
      [memberId, content_type, contentId]
    );
    for (const row of actives) {
      if (effectiveStatus(row, today) === 'EXPIRED') {
        // renewing over an expired row: retire it as history, insert fresh
        await client.query(
          `UPDATE gym_content_assignments
           SET status = 'ENDED', end_reason = 'superseded', ended_on = $2, updated_at = now()
           WHERE id = $1`,
          [row.id, row.ends_on]
        );
      } else {
        // in-window right now, or already scheduled for the future
        throw new HttpError(409, noun.dup);
      }
    }

    const { rows } = await client.query(
      `INSERT INTO gym_content_assignments
         (gym_id, content_type, workout_id, item_id, member_id, starts_on, ends_on,
          notes, assigned_version, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [gymId, content_type,
       content_type === 'WORKOUT' ? contentId : null,
       content_type === 'NUTRITION' ? contentId : null,
       memberId, start, end, clean, content.version, actor?.userId ?? actor ?? null]
    );
    const created = rows[0];
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'assignment.created', entity: 'gym_content_assignment', entityId: created.id,
      after: {
        content_type, content: content.title, member_id: memberId,
        starts_on: start, ends_on: end, assigned_version: content.version,
        notes: clean || undefined,
      },
    });
    return {
      ...created,
      starts_on: created.starts_on instanceof Date ? created.starts_on.toISOString().slice(0, 10) : created.starts_on,
      ends_on: created.ends_on instanceof Date
        ? created.ends_on.toISOString().slice(0, 10)
        : created.ends_on,
      content_title: content.title,
      effective_status: effectiveStatus(created, today),
      [content_type === 'WORKOUT' ? 'workout_title' : 'item_title']: content.title,
      [content_type === 'WORKOUT' ? 'workout_version' : 'item_version']: content.version,
    };
  });
}

// ── read ─────────────────────────────────────────────────────────────────

async function getAssignment(gymId, assignmentId) {
  const { rows } = await query(`${baseSelect()} WHERE a.gym_id = $1 AND a.id = $2`, [gymId, assignmentId]);
  return rows[0] || null;
}

// same projection, run on a TRANSACTION client (for reads inside an open tx
// that must see the tx's own uncommitted writes)
async function getAssignmentOnClient(client, gymId, assignmentId) {
  const { rows } = await client.query(`${baseSelect()} WHERE a.gym_id = $1 AND a.id = $2`, [gymId, assignmentId]);
  return rows[0] || null;
}

// Gym-wide list (staff). TRAINER callers are silently scoped to their own
// roster; everyone else sees the gym. Filters: member_id, content_type,
// content_id, effective_status, q (member name/code or content title).
async function listAssignments(gymId, ctx, { member_id, content_type, content_id, effective_status, q, limit, offset } = {}) {
  const vals = [gymId];
  const where = ['a.gym_id = $1'];
  if (ctx && ctx.gymRole === 'TRAINER') {
    vals.push(ctx.staffId);
    where.push(`a.member_id IN (SELECT member_id FROM gym_trainer_assignments
                WHERE gym_id = $1 AND trainer_staff_id = $${vals.length} AND status = 'ACTIVE')`);
  }
  if (member_id) { vals.push(member_id); where.push(`a.member_id = $${vals.length}`); }
  if (content_type) {
    if (!CONTENT_TYPES.includes(content_type)) throw new HttpError(400, 'content_type must be WORKOUT or NUTRITION');
    vals.push(content_type); where.push(`a.content_type = $${vals.length}`);
  }
  if (content_id) { vals.push(content_id); where.push(`(a.workout_id = $${vals.length} OR a.item_id = $${vals.length})`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(gm.first_name ILIKE $${vals.length} OR gm.last_name ILIKE $${vals.length}
                 OR gm.member_code ILIKE $${vals.length}
                 OR w.title ILIKE $${vals.length} OR n.title ILIKE $${vals.length})`);
  }
  let lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1) lim = 100;
  if (lim > 500) lim = 500;
  let off = Number(offset);
  if (!Number.isInteger(off) || off < 0) off = 0;

  const { rows } = await query(
    `SELECT * FROM (${baseSelect()} WHERE ${where.join(' AND ')}) q
     ${effective_status ? 'WHERE q.effective_status = $' + (vals.length + 1) : ''}
     ORDER BY q.created_at DESC
     LIMIT ${lim} OFFSET ${off}`,
    effective_status ? [...vals, effective_status] : vals
  );
  return rows;
}

// One member's full assignment history (both content types, ENDED included).
// Trainer callers may only look at their own roster members (403 otherwise).
async function listMemberAssignments(gymId, memberId, { content_type, ctx } = {}) {
  await assertCanManageMember(gymId, ctx, memberId);
  const vals = [gymId, memberId];
  const where = ['a.gym_id = $1', 'a.member_id = $2'];
  if (content_type) {
    if (!CONTENT_TYPES.includes(content_type)) throw new HttpError(400, 'content_type must be WORKOUT or NUTRITION');
    vals.push(content_type); where.push(`a.content_type = $${vals.length}`);
  }
  const { rows } = await query(
    `SELECT * FROM (${baseSelect()} WHERE ${where.join(' AND ')}) q
     ORDER BY q.created_at DESC`,
    vals
  );
  return rows;
}

// ── update (dates / notes only, while physically ACTIVE) ─────────────────

async function updateAssignment(gymId, assignmentId, actor, ip, patch = {}, gymAudit, ctx) {
  const fields = {};
  if (patch.starts_on !== undefined) fields.starts_on = String(patch.starts_on || '').slice(0, 10);
  if (patch.ends_on !== undefined) fields.ends_on = patch.ends_on == null || patch.ends_on === '' ? null : String(patch.ends_on).slice(0, 10);
  if (patch.notes !== undefined) fields.notes = cleanNotes(patch.notes);
  if (!Object.keys(fields).length) throw new HttpError(400, 'No valid fields to update (starts_on, ends_on, notes)');

  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_content_assignments WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
      [assignmentId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Assignment not found');
    const row = rows[0];
    if (row.status !== 'ACTIVE') throw new HttpError(400, 'This assignment has already ended');
    if (ctx && ctx.gymRole === 'TRAINER') await assertCanManageMember(gymId, ctx, row.member_id);

    const start = fields.starts_on ?? (row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : row.starts_on);
    const end = 'ends_on' in fields ? fields.ends_on : (row.ends_on == null ? null : (row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : row.ends_on));
    validateWindow(start, end);

    await client.query(
      `UPDATE gym_content_assignments
       SET starts_on = $2, ends_on = $3, notes = $4, updated_at = now()
       WHERE id = $1`,
      [assignmentId, start, end, 'notes' in fields ? fields.notes : row.notes]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'assignment.updated', entity: 'gym_content_assignment', entityId: assignmentId,
      before: { starts_on: row.starts_on, ends_on: row.ends_on, notes: row.notes },
      after: { starts_on: start, ends_on: end, notes: 'notes' in fields ? fields.notes : row.notes },
    });
    return getAssignmentOnClient(client, gymId, assignmentId);
  });
}

// ── end (manual; history kept; expiry is automatic and separate) ─────────

async function endAssignment(gymId, assignmentId, actor, ip, { reason } = {}, gymAudit, ctx) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_content_assignments WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
      [assignmentId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Assignment not found');
    if (rows[0].status !== 'ACTIVE') throw new HttpError(400, 'This assignment has already ended');
    if (ctx && ctx.gymRole === 'TRAINER') await assertCanManageMember(gymId, ctx, rows[0].member_id);
    const today = await gymToday(client, gymId);
    await client.query(
      `UPDATE gym_content_assignments
       SET status = 'ENDED', end_reason = $2, ended_on = $3, updated_at = now()
       WHERE id = $1`,
      [assignmentId, reason || 'unassigned', today]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'assignment.ended', entity: 'gym_content_assignment', entityId: assignmentId,
      after: { reason: reason || 'unassigned' },
    });
    return { ok: true };
  });
}

module.exports = {
  CONTENT_TYPES,
  assignContent, getAssignment, listAssignments, listMemberAssignments,
  updateAssignment, endAssignment, assertCanManageMember, effectiveStatus,
};
