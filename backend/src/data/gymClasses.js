// gymClasses.js — gym class scheduling & bookings (Phase 17).
//
// A gym_class is a SCHEDULED INSTANCE of a class type ("Yoga with Simran,
// tomorrow 18:00, Studio A, 20 seats"). One row per occurrence; wall times
// (class_date / start_time / end_time) are GYM-LOCAL like billing and
// attendance.
//
// BOOKING MODEL
//   BOOKED      holds a seat (occupied = BOOKED + ATTENDED)
//   WAITLISTED  class was full — FIFO queue by booked_at
//   CANCELLED   member/desk cancelled, or the class itself was cancelled
//   ATTENDED    marked present at the class
//   NO_SHOW     marked absent — frees the seat, waitlist promotes
//   At most one live row per member per class (two partial unique indexes
//   back the 409 checks at the DB level, so a race can never double-book).
//
// SEAT ACCOUNTING: any transition that frees a seat on a SCHEDULED class
// (booking cancelled, no-show marked) promotes the earliest WAITLISTED
// booking. Class cancellation cancels every live booking and promotes
// nobody.
//
// GATES (all enforced server-side, desk and self alike)
//   membership  term must be ACTIVE after lazy-expiry maintenance —
//               expired / frozen / cancelled / no term all refuse with a
//               clear reason
//   branch      when the class has one: branch ACTIVE, member access =
//               {primary} ∪ allowed (legacy members: all branches), and
//               the acting desk's own branch restriction
//   trainer     must be an ACTIVE TRAINER-role staff row, free of
//               overlapping classes, and (Phase 16) not restricted away
//               from the class branch
//   room        same branch + room cannot host overlapping classes
const { query, transaction } = require('../db/pool');
const plans = require('./membershipPlans');
const branches = require('./gymBranches');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

const BOOKING_STATUSES = ['BOOKED', 'WAITLISTED', 'CANCELLED', 'ATTENDED', 'NO_SHOW'];
const OCCUPIED = "('BOOKED', 'ATTENDED')";
const SOURCES = ['DESK', 'SELF'];

const str = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max) || null);

function cleanNotes(notes) {
  if (notes === undefined || notes === null) return null;
  const n = String(notes).trim();
  if (!n) return null;
  if (n.length > 500) throw new HttpError(400, 'notes must be 500 characters or fewer');
  return n;
}

function assertDate(v, field = 'class_date') {
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new HttpError(400, `${field} must be a YYYY-MM-DD date`);
  return v;
}

function assertTime(v, field) {
  if (typeof v !== 'string' || !TIME_RE.test(v.trim())) {
    throw new HttpError(400, `${field} must be a 24h HH:MM time`);
  }
  const [, h, m] = v.trim().match(TIME_RE);
  return `${h}:${m}:00`;
}

function assertCapacity(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new HttpError(400, 'capacity must be a whole number between 1 and 500');
  }
  return n;
}

// ── shared validation (create = full, update = partial) ───────────────────

function classValidation(data, { partial }) {
  const out = {};
  const has = (k) => data[k] !== undefined;

  if (has('class_type') || !partial) {
    const t = str(data.class_type, 80);
    if (!t) throw new HttpError(400, 'class_type is required (e.g. "Yoga")');
    out.class_type = t;
  }
  if (has('class_date') || !partial) out.class_date = assertDate(data.class_date);
  if (has('start_time') || !partial) out.start_time = assertTime(data.start_time, 'start_time');
  if (has('end_time') || !partial) out.end_time = assertTime(data.end_time, 'end_time');
  if (has('capacity') || !partial) out.capacity = assertCapacity(data.capacity);
  if (has('room')) out.room = str(data.room, 80);
  if (has('notes')) out.notes = cleanNotes(data.notes);

  if (out.start_time && out.end_time && out.end_time <= out.start_time) {
    throw new HttpError(400, 'end_time must be after start_time');
  }
  return out;
}

// resolve + validate the trainer for a class (create / update)
async function resolveTrainer(client, gymId, trainerStaffId, branchId) {
  const { rows } = await client.query(
    `SELECT s.id, s.status, s.gym_role, s.branch_ids, u.name AS trainer_name
     FROM gym_staff s LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.gym_id = $2`,
    [trainerStaffId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Trainer not found in this gym');
  const t = rows[0];
  if (t.gym_role !== 'TRAINER') throw new HttpError(400, 'The trainer must be a TRAINER-role staff member');
  if (t.status !== 'ACTIVE') throw new HttpError(409, 'This trainer is not active');
  if (branchId && (t.branch_ids || []).length && !t.branch_ids.includes(String(branchId))) {
    throw new HttpError(409, `${t.trainer_name || 'This trainer'} is restricted to other branches — pick a trainer at this branch or clear their branch restriction`);
  }
  return t;
}

// the same trainer cannot hold two overlapping SCHEDULED classes
async function assertTrainerFree(client, gymId, trainerStaffId, when, excludeClassId) {
  const { rows } = await client.query(
    `SELECT class_type, start_time::text, end_time::text FROM gym_classes
     WHERE gym_id = $1 AND trainer_staff_id = $2 AND class_date = $3
       AND status = 'SCHEDULED' AND start_time < $4::time AND end_time > $5::time
       AND ($6::uuid IS NULL OR id <> $6::uuid)
     LIMIT 1`,
    [gymId, trainerStaffId, when.class_date, when.end_time, when.start_time, excludeClassId || null]
  );
  if (rows.length) {
    throw new HttpError(409,
      `Trainer is already scheduled for "${rows[0].class_type}" ${rows[0].start_time.slice(0, 5)}–${rows[0].end_time.slice(0, 5)} that day`);
  }
}

// the same room cannot host overlapping classes (same branch only —
// rooms are physical spaces belonging to a branch)
async function assertRoomFree(client, gymId, branchId, room, when, excludeClassId) {
  if (!branchId || !room) return;
  const { rows } = await client.query(
    `SELECT class_type, start_time::text, end_time::text FROM gym_classes
     WHERE gym_id = $1 AND branch_id = $2 AND class_date = $3
       AND lower(btrim(room)) = lower(btrim($4))
       AND status = 'SCHEDULED' AND start_time < $5::time AND end_time > $6::time
       AND ($7::uuid IS NULL OR id <> $7::uuid)
     LIMIT 1`,
    [gymId, branchId, when.class_date, room, when.end_time, when.start_time, excludeClassId || null]
  );
  if (rows.length) {
    throw new HttpError(409,
      `Room "${room}" is already used by "${rows[0].class_type}" ${rows[0].start_time.slice(0, 5)}–${rows[0].end_time.slice(0, 5)} that day`);
  }
}

function assertBranchId(branchId) {
  if (!UUID_RE.test(String(branchId))) throw new HttpError(400, 'branch_id must be a branch id of this gym');
}

// ── create / list / detail / update / cancel (staff surface) ──────────────

async function createClass(gymId, actor, ip, payload = {}, gymAudit) {
  const v = classValidation(payload, { partial: false });
  const branchId = payload.branch_id != null && payload.branch_id !== '' ? payload.branch_id : null;
  if (branchId) assertBranchId(branchId);
  const trainerStaffId = payload.trainer_staff_id != null && payload.trainer_staff_id !== ''
    ? payload.trainer_staff_id : null;
  if (trainerStaffId && !UUID_RE.test(String(trainerStaffId))) {
    throw new HttpError(400, 'trainer_staff_id must be a staff id of this gym');
  }

  return transaction(async (client) => {
    if (branchId) {
      const { rows: b } = await client.query(
        'SELECT status FROM gym_branches WHERE id = $1 AND gym_id = $2', [branchId, gymId]
      );
      if (!b.length) throw new HttpError(404, 'Branch not found');
      if (b[0].status !== 'ACTIVE') throw new HttpError(409, 'That branch is closed — pick an active branch');
    }
    if (trainerStaffId) {
      await resolveTrainer(client, gymId, trainerStaffId, branchId);
      await assertTrainerFree(client, gymId, trainerStaffId, v, null);
    }
    await assertRoomFree(client, gymId, branchId, v.room || null, v, null);

    const { rows } = await client.query(
      `INSERT INTO gym_classes
         (gym_id, branch_id, class_type, trainer_staff_id, room, class_date,
          start_time, end_time, capacity, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [gymId, branchId, v.class_type, trainerStaffId, v.room || null, v.class_date,
        v.start_time, v.end_time, v.capacity, v.notes || null, actor.userId]
    );
    const created = rows[0];
    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.created',
      entity: 'gym_class', entityId: created.id,
      after: { class_type: created.class_type, class_date: created.class_date,
        start_time: created.start_time, capacity: created.capacity }, ip,
    });
    return await projectClassFull(client, gymId, created.id);
  });
}

const CLASS_LIST_SELECT = `
  SELECT c.id, c.gym_id, c.branch_id, c.class_type, c.trainer_staff_id, c.room,
         c.class_date::text AS class_date, c.start_time::text AS start_time,
         c.end_time::text AS end_time, c.capacity, c.status, c.notes,
         c.cancelled_at, c.cancel_reason,
         b.name AS branch_name,
         tu.name AS trainer_name,
         (SELECT COUNT(*)::int FROM gym_class_bookings x
           WHERE x.class_id = c.id AND x.status IN ${OCCUPIED}) AS booked_count,
         (SELECT COUNT(*)::int FROM gym_class_bookings x
           WHERE x.class_id = c.id AND x.status = 'WAITLISTED') AS waitlist_count
  FROM gym_classes c
  LEFT JOIN gym_branches b ON b.id = c.branch_id
  LEFT JOIN gym_staff s ON s.id = c.trainer_staff_id
  LEFT JOIN users tu ON tu.id = s.user_id`;

async function listClasses(gymId, { from, to, status, branch_id, type, limit = 100, offset = 0 } = {}) {
  const where = ['c.gym_id = $1'];
  const params = [gymId];
  if (from) { params.push(assertDate(from, 'from')); where.push(`c.class_date >= $${params.length}`); }
  if (to) { params.push(assertDate(to, 'to')); where.push(`c.class_date <= $${params.length}`); }
  if (status && status !== 'ALL') {
    if (!['SCHEDULED', 'CANCELLED'].includes(status)) throw new HttpError(400, 'status must be SCHEDULED, CANCELLED or ALL');
    where.push(`c.status = '${status}'`);
  }
  if (branch_id) { assertBranchId(branch_id); params.push(branch_id); where.push(`c.branch_id = $${params.length}`); }
  if (type) { params.push(`%${String(type).trim()}%`); where.push(`c.class_type ILIKE $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  params.push(lim, off);

  const { rows } = await query(
    `${CLASS_LIST_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY c.class_date, c.start_time, c.created_at
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// full projection with join enrichment (branch/trainer names + counts)
async function projectClassFull(runner, gymId, classId) {
  const { rows } = await runner.query(
    `${CLASS_LIST_SELECT} WHERE c.id = $1 AND c.gym_id = $2`, [classId, gymId]
  );
  return rows[0];
}

async function loadClassRow(client, gymId, classId) {
  if (!UUID_RE.test(String(classId))) throw new HttpError(404, 'Class not found');
  const { rows } = await client.query(
    `SELECT c.*, g.timezone FROM gym_classes c JOIN gyms g ON g.id = c.gym_id
     WHERE c.id = $1 AND c.gym_id = $2 FOR UPDATE OF c`,
    [classId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Class not found');
  return rows[0];
}

async function getClass(gymId, classId) {
  if (!UUID_RE.test(String(classId))) throw new HttpError(404, 'Class not found');
  const { rows } = await query(
    `${CLASS_LIST_SELECT} WHERE c.id = $1 AND c.gym_id = $2`, [classId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Class not found');
  const { rows: bookings } = await query(
    `SELECT bk.id, bk.class_id, bk.member_id, bk.status, bk.source, bk.booked_at,
            bk.cancelled_at, bk.cancel_reason, bk.attended_at,
            gm.member_code, gm.first_name, gm.last_name,
            (SELECT COUNT(*)::int FROM gym_class_bookings w
              WHERE w.class_id = bk.class_id AND w.status = 'WAITLISTED'
                AND (w.booked_at, w.id) < (bk.booked_at, bk.id)) + 1 AS waitlist_position
     FROM gym_class_bookings bk
     JOIN gym_members gm ON gm.id = bk.member_id
     WHERE bk.class_id = $1 AND bk.gym_id = $2
     ORDER BY (bk.status IN ('BOOKED','ATTENDED')) DESC, bk.booked_at, bk.id`,
    [classId, gymId]
  );
  return { ...rows[0], bookings };
}

async function updateClass(gymId, classId, actor, ip, payload = {}, gymAudit) {
  const v = classValidation(payload, { partial: true });
  return transaction(async (client) => {
    const current = await loadClassRow(client, gymId, classId);
    if (current.status === 'CANCELLED') throw new HttpError(409, 'Cannot edit a cancelled class');

    const next = {
      class_date: v.class_date ?? current.class_date,
      start_time: v.start_time ?? current.start_time,
      end_time: v.end_time ?? current.end_time,
      capacity: v.capacity ?? current.capacity,
      branch_id: payload.branch_id !== undefined
        ? (payload.branch_id ? payload.branch_id : null)
        : current.branch_id,
      room: v.room !== undefined ? v.room : current.room,
      trainer_staff_id: payload.trainer_staff_id !== undefined
        ? (payload.trainer_staff_id ? payload.trainer_staff_id : null)
        : current.trainer_staff_id,
    };
    if (next.end_time <= next.start_time) throw new HttpError(400, 'end_time must be after start_time');

    // capacity can never drop below the seats already held
    if (next.capacity !== current.capacity) {
      const { rows: occ } = await client.query(
        `SELECT COUNT(*)::int AS n FROM gym_class_bookings
         WHERE class_id = $1 AND status IN ${OCCUPIED}`, [classId]
      );
      if (occ[0].n > next.capacity) {
        throw new HttpError(409, `Capacity cannot go below ${occ[0].n} — that many members already hold a seat`);
      }
    }

    if (next.branch_id && next.branch_id !== current.branch_id) {
      assertBranchId(next.branch_id);
      const { rows: b } = await client.query(
        'SELECT status FROM gym_branches WHERE id = $1 AND gym_id = $2', [next.branch_id, gymId]
      );
      if (!b.length) throw new HttpError(404, 'Branch not found');
      if (b[0].status !== 'ACTIVE') throw new HttpError(409, 'That branch is closed');
    }
    if (next.trainer_staff_id && next.trainer_staff_id !== current.trainer_staff_id) {
      if (!UUID_RE.test(String(next.trainer_staff_id))) throw new HttpError(400, 'trainer_staff_id must be a staff id of this gym');
      await resolveTrainer(client, gymId, next.trainer_staff_id, next.branch_id);
    }
    if (next.trainer_staff_id
      && (next.class_date !== current.class_date || next.start_time !== current.start_time
        || next.end_time !== current.end_time || next.trainer_staff_id !== current.trainer_staff_id
        || next.branch_id !== current.branch_id)) {
      await assertTrainerFree(client, gymId, next.trainer_staff_id, next, classId);
    }
    if (next.room && next.branch_id
      && (next.room !== current.room || next.class_date !== current.class_date
        || next.start_time !== current.start_time || next.end_time !== current.end_time)) {
      await assertRoomFree(client, gymId, next.branch_id, next.room, next, classId);
    }

    const { rows } = await client.query(
      `UPDATE gym_classes SET class_type = $3, branch_id = $4, trainer_staff_id = $5,
              room = $6, class_date = $7, start_time = $8, end_time = $9,
              capacity = $10, notes = $11, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [classId, gymId, v.class_type ?? current.class_type, next.branch_id,
        next.trainer_staff_id, next.room, next.class_date, next.start_time,
        next.end_time, next.capacity, v.notes !== undefined ? v.notes : current.notes]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.updated',
      entity: 'gym_class', entityId: classId,
      before: { capacity: current.capacity, class_date: current.class_date,
        start_time: current.start_time, status: current.status },
      after: { capacity: rows[0].capacity, class_date: rows[0].class_date,
        start_time: rows[0].start_time, status: rows[0].status }, ip,
    });
    return await projectClassFull(client, gymId, classId);
  });
}

// cancelling is terminal for the class: every live booking becomes
// CANCELLED (reason class_cancelled); ATTENDED/NO_SHOW rows keep history
async function cancelClass(gymId, classId, actor, ip, { reason } = {}, gymAudit) {
  return transaction(async (client) => {
    const cls = await loadClassRow(client, gymId, classId);
    if (cls.status === 'CANCELLED') return projectClassFull(client, gymId, classId); // idempotent

    const { rows } = await client.query(
      `UPDATE gym_classes SET status = 'CANCELLED', cancelled_at = now(),
              cancelled_by = $3, cancel_reason = $4, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [classId, gymId, actor.userId, cleanNotes(reason) || null]
    );
    await client.query(
      `UPDATE gym_class_bookings
       SET status = 'CANCELLED', cancelled_at = now(),
           cancel_reason = COALESCE(cancel_reason, 'class_cancelled'), updated_at = now()
       WHERE class_id = $1 AND status IN ('BOOKED', 'WAITLISTED')`,
      [classId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.cancelled',
      entity: 'gym_class', entityId: classId,
      before: { status: 'SCHEDULED' }, after: { status: 'CANCELLED', reason: reason || null }, ip,
    });
    return projectClassFull(client, gymId, classId);
  });
}

// ── membership gate (shared by desk and self booking) ─────────────────────

// lazy expiry runs first so an overdue ACTIVE term reads EXPIRED here.
// Classes are a member benefit: the LATEST term must be ACTIVE — expired,
// frozen, cancelled and no-term members all refuse with a clear reason.
async function assertBookableMember(client, gymId, memberId) {
  await plans.runMembershipMaintenance(client, gymId);
  const { rows } = await client.query(
    `SELECT gm.id, gm.status AS member_status, gm.member_code,
            gm.first_name, gm.last_name, gm.primary_branch_id, gm.allowed_branch_ids,
            t.status AS term_status
     FROM gym_members gm
     LEFT JOIN LATERAL (
       SELECT status FROM member_memberships t
       WHERE t.member_id = gm.id
       ORDER BY (t.status = 'ACTIVE') DESC, t.starts_on DESC, t.created_at DESC
       LIMIT 1
     ) t ON true
     WHERE gm.id = $1 AND gm.gym_id = $2`,
    [memberId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Member not found');
  const m = rows[0];
  if (m.member_status === 'CANCELLED') {
    throw new HttpError(400, 'This member has left the gym — reactivate them first');
  }
  if (!m.term_status) {
    throw new HttpError(409, 'An active membership is required to book classes');
  }
  if (m.term_status === 'EXPIRED') {
    throw new HttpError(409, 'Membership expired — renew it to book classes');
  }
  if (m.term_status === 'FROZEN') {
    throw new HttpError(409, 'Membership is frozen — resume it to book classes');
  }
  if (m.term_status !== 'ACTIVE') {
    throw new HttpError(409, `Membership is ${m.term_status.toLowerCase()} — an active membership is required to book classes`);
  }
  return m;
}

// ── booking (desk for ANY member incl. non-app; self for app members) ─────

async function bookClass(gymId, classId, memberId, { source = 'DESK', actor, ip, staff_branch_ids = null }, gymAudit) {
  if (!SOURCES.includes(source)) throw new HttpError(400, 'invalid booking source');
  return transaction(async (client) => {
    const cls = await loadClassRow(client, gymId, classId);
    if (cls.status === 'CANCELLED') throw new HttpError(409, 'This class was cancelled');
    // a class that already ended (gym-local) can no longer be booked
    const { rows: over } = await client.query(
      `SELECT (c.class_date + c.end_time) <= (now() AT TIME ZONE g.timezone) AS over
       FROM gym_classes c JOIN gyms g ON g.id = c.gym_id WHERE c.id = $1`,
      [classId]
    );
    if (over[0].over) throw new HttpError(409, 'This class is already over');

    const member = await assertBookableMember(client, gymId, memberId);

    // branch: ACTIVE + member access ({primary} ∪ allowed; legacy = all)
    // + the acting desk's own restriction (desk bookings only)
    if (cls.branch_id) {
      const { rows: b } = await client.query(
        'SELECT name, status FROM gym_branches WHERE id = $1 AND gym_id = $2', [cls.branch_id, gymId]
      );
      if (!b.length) throw new HttpError(404, 'Branch not found');
      if (b[0].status !== 'ACTIVE') throw new HttpError(409, `Branch "${b[0].name}" is closed`);
      if (member.primary_branch_id) {
        const reachable = [member.primary_branch_id, ...(member.allowed_branch_ids || [])];
        if (!reachable.includes(String(cls.branch_id))) {
          throw new HttpError(409, `This class is at ${b[0].name} — outside this member's branches`);
        }
      }
      if (staff_branch_ids && staff_branch_ids.length && !staff_branch_ids.includes(String(cls.branch_id))) {
        throw new HttpError(403, 'This branch is outside your assigned branches');
      }
    }

    // duplicate booking: one live row per member per class (the partial
    // unique indexes are the hard backstop under a race)
    const { rows: live } = await client.query(
      `SELECT id, status FROM gym_class_bookings
       WHERE class_id = $1 AND member_id = $2 AND status IN ('BOOKED', 'ATTENDED', 'WAITLISTED')`,
      [classId, memberId]
    );
    if (live.length) {
      throw new HttpError(409,
        live[0].status === 'WAITLISTED'
          ? 'Already on the waitlist for this class'
          : 'Already booked in this class');
    }

    const { rows: occ } = await client.query(
      `SELECT COUNT(*)::int AS n FROM gym_class_bookings
       WHERE class_id = $1 AND status IN ${OCCUPIED}`, [classId]
    );
    const full = occ[0].n >= cls.capacity;
    const status = full ? 'WAITLISTED' : 'BOOKED';

    const { rows } = await client.query(
      `INSERT INTO gym_class_bookings (gym_id, class_id, member_id, status, source, booked_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [gymId, classId, memberId, status, source, actor.userId]
    );

    let waitlist_position = null;
    if (full) {
      const { rows: wp } = await client.query(
        `SELECT COUNT(*)::int AS p FROM gym_class_bookings
         WHERE class_id = $1 AND status = 'WAITLISTED'
           AND (booked_at, id) < ($2, $3)`, [classId, rows[0].booked_at, rows[0].id]
      );
      waitlist_position = wp[0].p + 1;
    }

    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.booked',
      entity: 'gym_class_booking', entityId: rows[0].id,
      after: { class_id: classId, member_id: memberId, status, source,
        waitlist_position, capacity: cls.capacity, booked: occ[0].n + (full ? 0 : 1) }, ip,
    });

    return {
      id: rows[0].id, class_id: classId, member_id: memberId,
      status, waitlist_position, spots_left: Math.max(cls.capacity - occ[0].n - (full ? 0 : 1), 0),
    };
  });
}

// FIFO promotion: fills every free seat with the earliest WAITLISTED rows.
// Caller holds the class row lock, so capacity is stable inside the tx.
async function promoteFromWaitlist(client, classId) {
  const { rows } = await client.query(
    `WITH occ AS (
       SELECT COUNT(*)::int AS n FROM gym_class_bookings
       WHERE class_id = $1 AND status IN ${OCCUPIED}
     ), promote AS (
       SELECT id FROM gym_class_bookings
       WHERE class_id = $1 AND status = 'WAITLISTED'
       ORDER BY booked_at, id
       LIMIT GREATEST((SELECT capacity FROM gym_classes WHERE id = $1) - (SELECT n FROM occ), 0)
     )
     UPDATE gym_class_bookings b SET status = 'BOOKED', updated_at = now()
     FROM promote WHERE b.id = promote.id
     RETURNING b.id, b.member_id`,
    [classId]
  );
  return rows;
}

async function cancelBooking(gymId, classId, bookingId, { reason, actor, ip }, gymAudit) {
  return transaction(async (client) => {
    const cls = await loadClassRow(client, gymId, classId);
    if (cls.status === 'CANCELLED') throw new HttpError(409, 'This class was cancelled — its bookings were already released');
    if (!UUID_RE.test(String(bookingId))) throw new HttpError(404, 'Booking not found');
    const { rows } = await client.query(
      `SELECT id, status, member_id FROM gym_class_bookings
       WHERE id = $1 AND class_id = $2 AND gym_id = $3`,
      [bookingId, classId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Booking not found');
    const bk = rows[0];
    if (bk.status === 'CANCELLED') throw new HttpError(409, 'This booking is already cancelled');
    if (bk.status === 'ATTENDED' || bk.status === 'NO_SHOW') {
      throw new HttpError(409, `Attendance was already recorded (${bk.status}) — correct it via attendance instead`);
    }

    await client.query(
      `UPDATE gym_class_bookings SET status = 'CANCELLED', cancelled_at = now(),
              cancel_reason = $2, updated_at = now()
       WHERE id = $1`,
      [bookingId, cleanNotes(reason) || 'member_cancelled']
    );
    const promoted = bk.status === 'BOOKED' ? await promoteFromWaitlist(client, classId) : [];

    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.booking_cancelled',
      entity: 'gym_class_booking', entityId: bookingId,
      before: { status: bk.status }, after: { status: 'CANCELLED', reason: reason || 'member_cancelled',
        promoted: promoted.length }, ip,
    });
    return { id: bookingId, status: 'CANCELLED', promoted: promoted.length };
  });
}

// attendance: ATTENDED (present) | NO_SHOW (absent, seat freed, waitlist
// promotes) | BOOKED (undo a mis-mark). NO_SHOW and ATTENDED can be
// corrected into each other while the class row is still SCHEDULED.
async function setAttendance(gymId, classId, bookingId, attendance, actor, ip, gymAudit) {
  if (!['ATTENDED', 'NO_SHOW', 'BOOKED'].includes(attendance)) {
    throw new HttpError(400, 'attendance must be ATTENDED, NO_SHOW or BOOKED');
  }
  return transaction(async (client) => {
    const cls = await loadClassRow(client, gymId, classId);
    if (cls.status === 'CANCELLED') throw new HttpError(409, 'This class was cancelled');
    if (!UUID_RE.test(String(bookingId))) throw new HttpError(404, 'Booking not found');
    const { rows } = await client.query(
      `SELECT id, status, member_id FROM gym_class_bookings
       WHERE id = $1 AND class_id = $2 AND gym_id = $3`,
      [bookingId, classId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Booking not found');
    const bk = rows[0];
    if (bk.status === 'WAITLISTED') throw new HttpError(409, 'This member is on the waitlist — they hold no seat to mark');
    if (bk.status === 'CANCELLED') throw new HttpError(409, 'This booking was cancelled');

    if (attendance === 'BOOKED') {
      // undo: re-occupying the seat needs a free seat again
      const { rows: occ } = await client.query(
        `SELECT COUNT(*)::int AS n FROM gym_class_bookings
         WHERE class_id = $1 AND status IN ${OCCUPIED} AND id <> $2`, [classId, bookingId]
      );
      if (occ[0].n >= cls.capacity) throw new HttpError(409, 'No free seat to restore this booking — the seat was taken from the waitlist');
    }

    await client.query(
      `UPDATE gym_class_bookings SET status = $2,
              attended_at = CASE WHEN $2 IN ('ATTENDED', 'NO_SHOW') THEN now() ELSE NULL END,
              updated_at = now()
       WHERE id = $1`,
      [bookingId, attendance]
    );
    const promoted = attendance === 'NO_SHOW' && bk.status === 'BOOKED'
      ? await promoteFromWaitlist(client, classId) : [];

    await gymAudit(client, {
      gymId, actorUserId: actor.userId, action: 'class.attendance',
      entity: 'gym_class_booking', entityId: bookingId,
      before: { status: bk.status }, after: { status: attendance, promoted: promoted.length }, ip,
    });
    return { id: bookingId, status: attendance, promoted: promoted.length };
  });
}

// ── member mobile surface (member resolved from the JWT) ──────────────────

// Upcoming SCHEDULED classes across the user's ACTIVE gym memberships,
// branch-filtered to what the member can access, with their own live
// booking status per class. Classes that already ended (gym-local) drop off.
async function listMyClasses(userId, { limit = 60 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
  const { rows } = await query(
    `SELECT c.id, c.gym_id, g.name AS gym_name, c.class_type, c.class_date::text AS class_date,
            c.start_time::text AS start_time, c.end_time::text AS end_time,
            c.capacity, c.room, c.status,
            b.name AS branch_name, tu.name AS trainer_name,
            occ.n AS booked_count,
            my.id AS my_booking_id, my.status AS my_status,
            GREATEST(c.capacity - occ.n, 0) AS spots_left
     FROM gym_members gm
     JOIN gyms g ON g.id = gm.gym_id AND g.status = 'ACTIVE'
     JOIN gym_classes c ON c.gym_id = g.id
       AND c.status = 'SCHEDULED'
       AND (c.class_date > (now() AT TIME ZONE g.timezone)::date
         OR (c.class_date = (now() AT TIME ZONE g.timezone)::date
           AND c.end_time > (now() AT TIME ZONE g.timezone)::time))
     LEFT JOIN gym_branches b ON b.id = c.branch_id
     LEFT JOIN gym_staff s ON s.id = c.trainer_staff_id
     LEFT JOIN users tu ON tu.id = s.user_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS n FROM gym_class_bookings x
       WHERE x.class_id = c.id AND x.status IN ${OCCUPIED}
     ) occ ON true
     LEFT JOIN LATERAL (
       SELECT id, status FROM gym_class_bookings mb
       WHERE mb.class_id = c.id AND mb.member_id = gm.id
         AND mb.status IN ('BOOKED', 'ATTENDED', 'WAITLISTED')
       ORDER BY mb.booked_at DESC LIMIT 1
     ) my ON true
     WHERE gm.app_user_id = $1 AND gm.status = 'ACTIVE'
       AND (c.branch_id IS NULL OR gm.primary_branch_id IS NULL
         OR c.branch_id = gm.primary_branch_id
         OR c.branch_id = ANY(gm.allowed_branch_ids))
     ORDER BY c.class_date, c.start_time, g.name
     LIMIT $2`,
    [userId, lim]
  );
  return rows;
}

async function myBookClass(userId, classId, actor, ip, gymAudit) {
  if (!UUID_RE.test(String(classId))) throw new HttpError(404, 'Class not found');
  const { rows } = await query(
    `SELECT gm.id AS member_id, c.gym_id FROM gym_members gm
     JOIN gym_classes c ON c.gym_id = gm.gym_id
     WHERE gm.app_user_id = $1 AND c.id = $2 AND gm.status = 'ACTIVE'`,
    [userId, classId]
  );
  if (!rows.length) throw new HttpError(403, 'You are not an active member of this gym');
  return bookClass(rows[0].gym_id, classId, rows[0].member_id,
    { source: 'SELF', actor, ip, staff_branch_ids: null }, gymAudit);
}

async function myCancelBooking(userId, classId, actor, ip, gymAudit, { reason } = {}) {
  if (!UUID_RE.test(String(classId))) throw new HttpError(404, 'Class not found');
  const { rows } = await query(
    `SELECT bk.id, bk.class_id, c.gym_id FROM gym_class_bookings bk
     JOIN gym_members gm ON gm.id = bk.member_id
     JOIN gym_classes c ON c.id = bk.class_id
     WHERE gm.app_user_id = $1 AND c.id = $2 AND bk.status IN ('BOOKED', 'WAITLISTED')
     ORDER BY bk.booked_at DESC LIMIT 1`,
    [userId, classId]
  );
  if (!rows.length) throw new HttpError(404, 'You have no live booking for this class');
  return cancelBooking(rows[0].gym_id, classId, rows[0].id, { reason, actor, ip }, gymAudit);
}

module.exports = {
  createClass, listClasses, getClass, updateClass, cancelClass,
  bookClass, cancelBooking, setAttendance, listMyClasses, myBookClass, myCancelBooking,
};
