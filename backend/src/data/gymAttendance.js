// gymAttendance.js — the attendance ledger (Phase 10).
//
// IDEMPOTENCY RULE: one visit = one record. A new record is created only
// when the member has no record on the same gym-local calendar day AND no
// record within the previous 6 hours (covers QR re-scans, a workout
// completion after a morning QR, and visits spanning midnight). The check
// runs inside the transaction with the latest record locked (FOR UPDATE).
//
// SOURCE RULES:
//   QR_CHECK_IN / WORKOUT_COMPLETION — strict: the member must be ACTIVE
//     and, if a membership term exists, it must be ACTIVE. A FROZEN,
//     EXPIRED or CANCELLED term rejects with a clear reason (the mobile
//     app only prompts when the membership is active anyway).
//   FRONT_DESK / ADMIN_MANUAL — desk discretion: any member except one who
//     has CANCELLED (left the gym); a non-active membership produces a
//     warning in the response instead of a rejection.
//
// TIME: check_in_at is a server instant; local_date is derived in the
// gym's timezone. Offline syncs may claim a client_time — future-claimed
// times (device clock wrong) are replaced by server time and flagged
// (time_corrected), never trusted blindly.
const crypto = require('crypto');
const { query, transaction } = require('../db/pool');
const plans = require('./membershipPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SOURCES = ['QR_CHECK_IN', 'FRONT_DESK', 'WORKOUT_COMPLETION', 'ADMIN_MANUAL'];
const VISIT_WINDOW_HOURS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── QR identity ──────────────────────────────────────────────────────────

// Get-or-create the member's QR token. The token is 128-bit random — NOT
// the member code (codes are human-readable; tokens are not guessable).
async function ensureQrToken(gymId, memberId) {
  const { rows } = await query(
    `UPDATE gym_members
     SET qr_token = COALESCE(qr_token, $3), qr_issued_at = COALESCE(qr_issued_at, now())
     WHERE id = $1 AND gym_id = $2
     RETURNING id, member_code, first_name, last_name, qr_token, qr_issued_at`,
    [memberId, gymId, crypto.randomBytes(16).toString('hex')]
  );
  if (!rows.length) throw new HttpError(404, 'Member not found');
  return rows[0];
}

// Rotate (front desk re-issues a lost card).
async function rotateQrToken(gymId, memberId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const token = crypto.randomBytes(16).toString('hex');
    const { rows } = await client.query(
      `UPDATE gym_members SET qr_token = $3, qr_issued_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING id, member_code, qr_token, qr_issued_at`,
      [memberId, gymId, token]
    );
    if (!rows.length) throw new HttpError(404, 'Member not found');
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.qr_rotated', entity: 'gym_member', entityId: memberId,
    });
    return rows[0];
  });
}

// Resolve a scanned token. A token from ANOTHER gym returns null — the
// caller responds identically to an invalid QR (never leaks existence).
async function resolveQrToken(gymId, token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await query(
    `SELECT id, gym_id, member_code, first_name, last_name, status
     FROM gym_members WHERE qr_token = $1 LIMIT 1`,
    [String(token).trim().toLowerCase()]
  );
  const member = rows[0] || null;
  // a token from ANOTHER gym resolves to null — the caller answers it
  // exactly like an invalid QR (never leaks another gym's members)
  if (!member || member.gym_id !== gymId) return null;
  return member;
}

// ── membership eligibility (source-aware) ────────────────────────────────

async function eligibility(client, gymId, memberId, source) {
  // lazy expiry first: an overdue ACTIVE term must read EXPIRED here, not
  // keep admitting a member whose membership lapsed
  await plans.runMembershipMaintenance(client, gymId);
  const { rows } = await client.query(
    `SELECT gm.id, gm.status AS member_status, gm.member_code,
            gm.first_name, gm.last_name,
            mm.status AS membership_status, mm.plan_name, mm.ends_on
     FROM gym_members gm
     LEFT JOIN LATERAL (
       -- the member's LATEST term of ANY status: an EXPIRED/CANCELLED term
       -- must be visible here, otherwise a lapsed member would look like a
       -- never-had-a-membership member and slip through QR checks
       SELECT status, plan_name, ends_on FROM member_memberships t
       WHERE t.member_id = gm.id
       ORDER BY (t.status = 'ACTIVE') DESC, t.starts_on DESC, t.created_at DESC
       LIMIT 1
     ) mm ON true
     WHERE gm.id = $1 AND gm.gym_id = $2`,
    [memberId, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Member not found');
  const m = rows[0];

  if (m.member_status === 'CANCELLED') {
    throw new HttpError(403, 'This member has left the gym — attendance cannot be recorded');
  }
  const strict = source === 'QR_CHECK_IN' || source === 'WORKOUT_COMPLETION';
  if (strict) {
    if (m.member_status !== 'ACTIVE') {
      throw new HttpError(403, 'Membership not active');
    }
    // a member with NO term at all is allowed (trial / day visitor); a term
    // that exists but is not ACTIVE is not (expired/frozen/cancelled term)
    if (m.membership_status && m.membership_status !== 'ACTIVE') {
      throw new HttpError(403, `Membership ${m.membership_status.toLowerCase()} — attendance not allowed`);
    }
  }
  const warning = (!strict && m.membership_status && m.membership_status !== 'ACTIVE')
    ? `Membership is ${m.membership_status.toLowerCase()} — recorded at desk discretion`
    : null;
  return { member: m, warning };
}

// ── the one visit = one record check-in ──────────────────────────────────

async function recordCheckIn(gymId, memberId, source, actor, ip, { when, note } = {}, gymAudit) {
  if (!SOURCES.includes(source)) throw new HttpError(400, 'invalid attendance source');
  let claimedTime = null;
  let timeCorrected = false;
  return transaction(async (client) => {
    const { member, warning } = await eligibility(client, gymId, memberId, source);

    // resolve the instant: server time unless an offline sync claims a time
    let checkInAt;
    const { rows: tzRows } = await client.query(
      `SELECT (now() AT TIME ZONE g.timezone)::date AS today,
              now() AT TIME ZONE g.timezone AS local_now
       FROM gyms g WHERE g.id = $1`, [gymId]
    );
    const today = tzRows[0].today;
    if (when) {
      claimedTime = new Date(when);
      // offline sync: accept the claimed time unless the device clock is
      // wrong (claims the future) — never trust a future device stamp
      if (claimedTime > new Date(`${today}T23:59:59Z`)) {
        checkInAt = new Date();
        timeCorrected = true;
      } else {
        checkInAt = claimedTime;
      }
    } else {
      checkInAt = new Date();
    }

    // IDEMPOTENCY: lock the member's latest record; same local day or
    // within the visit window → this attempt IS that visit (no new row).
    const { rows: prevRows } = await client.query(
      `SELECT a.id, a.local_date, a.source, a.check_in_at,
              (a.check_in_at AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $2))::date AS prev_local_date
       FROM gym_attendance a
       WHERE a.gym_id = $2 AND a.member_id = $1
       ORDER BY a.check_in_at DESC LIMIT 1 FOR UPDATE`,
      [memberId, gymId]
    );
    const prev = prevRows[0];
    if (prev) {
      const hoursSince = (checkInAt - new Date(prev.check_in_at)) / 3600000;
      const localDateOfCheckIn = (
        await client.query(
          `SELECT ($1::timestamptz AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $2))::date AS d`,
          [checkInAt, gymId]
        )
      ).rows[0].d;
      if (prev.prev_local_date === localDateOfCheckIn || (hoursSince >= 0 && hoursSince < VISIT_WINDOW_HOURS)) {
        return {
          attendance: prev, duplicate: true, warning,
          member: { id: memberId, name: `${member.first_name} ${member.last_name || ''}`.trim(), member_code: member.member_code },
        };
      }
    }

    const { rows } = await client.query(
      `INSERT INTO gym_attendance
         (gym_id, member_id, source, check_in_at, local_date, client_time, time_corrected, recorded_by, note)
       VALUES ($1,$2,$3,$4::timestamptz,
               ($4::timestamptz AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date,
               $5,$6,$7,$8) RETURNING *`,
      [gymId, memberId, source, checkInAt, claimedTime, timeCorrected,
       actor?.userId ?? actor ?? null, note ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'attendance.recorded', entity: 'gym_attendance', entityId: rows[0].id,
      after: { source, local_date: rows[0].local_date, member_id: memberId },
    });
    return {
      attendance: rows[0], duplicate: false, warning,
      member: { id: memberId, name: `${member.first_name} ${member.last_name || ''}`.trim(), member_code: member.member_code },
    };
  });
}

// Offline batch: a scanner that was offline syncs queued scans. Per-item
// result so partial failures never lose the rest of the queue.
async function recordOfflineBatch(gymId, actor, ip, { items } = {}, gymAudit) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'items is required');
  if (items.length > 200) throw new HttpError(400, 'batch too large (max 200)');
  const results = [];
  for (const item of items) {
    try {
      let memberId = item.member_id;
      if (!memberId && item.qr_token) {
        const m = await resolveQrToken(gymId, item.qr_token);
        if (!m) { results.push({ ok: false, reason: 'invalid_qr', qr_token: item.qr_token }); continue; }
        memberId = m.id;
      }
      if (!memberId) { results.push({ ok: false, reason: 'member_id_or_qr_required' }); continue; }
      const r = await recordCheckIn(gymId, memberId, item.source || 'QR_CHECK_IN', actor, ip,
        { when: item.client_time, note: item.note }, gymAudit);
      results.push({ ok: true, member_id: memberId, duplicate: r.duplicate, attendance: r.attendance });
    } catch (e) {
      results.push({ ok: false, member_id: item.member_id, reason: e.status ? e.message : 'failed' });
    }
  }
  return { results };
}

// ── manual correction ────────────────────────────────────────────────────

// Backdated manual entry (up to 90 days) — same dedupe rule applies.
async function recordManual(gymId, memberId, actor, ip, { local_date, note } = {}, gymAudit) {
  if (!local_date || !DATE_RE.test(String(local_date))) {
    throw new HttpError(400, 'local_date must be a YYYY-MM-DD date');
  }
  return transaction(async (client) => {
    await eligibility(client, gymId, memberId, 'ADMIN_MANUAL');
    const { rows: tzRows } = await client.query(
      `SELECT (now() AT TIME ZONE g.timezone)::date AS today,
              now() AT TIME ZONE g.timezone AS local_now
       FROM gyms g WHERE g.id = $1`, [gymId]
    );
    const today = tzRows[0].today;
    if (local_date > today) throw new HttpError(400, 'Attendance cannot be recorded for a future date');
    const daysBack = Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${local_date}T00:00:00Z`)) / 86400000);
    if (daysBack > 90) throw new HttpError(400, 'Manual entries can only go back 90 days');

    const { rows: prevRows } = await client.query(
      `SELECT id, local_date FROM gym_attendance
       WHERE gym_id = $1 AND member_id = $2 AND local_date = $3 FOR UPDATE`,
      [gymId, memberId, local_date]
    );
    if (prevRows.length) {
      return { attendance: prevRows[0], duplicate: true };
    }
    // representative instant: 10:00 gym-local on that day
    const at = await client.query(
      `SELECT ($1::date::timestamp AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $2))
         + INTERVAL '10 hours' AS ts`,
      [local_date, gymId]
    );
    const { rows } = await client.query(
      `INSERT INTO gym_attendance (gym_id, member_id, source, check_in_at, local_date, recorded_by, note)
       VALUES ($1,$2,'ADMIN_MANUAL',$3::timestamptz,$4::date,$5,$6) RETURNING *`,
      [gymId, memberId, at.rows[0].ts, local_date, actor?.userId ?? actor ?? null, note ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'attendance.recorded', entity: 'gym_attendance', entityId: rows[0].id,
      after: { source: 'ADMIN_MANUAL', local_date, backdated: daysBack },
    });
    return { attendance: rows[0], duplicate: false };
  });
}

// Manual correction = removing a wrongly-created record (attendance.manage).
async function deleteAttendance(gymId, attendanceId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_attendance WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
      [attendanceId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Attendance record not found');
    await client.query('DELETE FROM gym_attendance WHERE id = $1', [attendanceId]);
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'attendance.deleted', entity: 'gym_attendance', entityId: attendanceId,
      before: { local_date: rows[0].local_date, source: rows[0].source },
    });
    return { ok: true };
  });
}

// ── reads ────────────────────────────────────────────────────────────────

async function listAttendance(gymId, { date, member_id, limit = 100, offset = 0 } = {}) {
  const vals = [gymId];
  const where = ['a.gym_id = $1'];
  if (date) { if (!DATE_RE.test(String(date))) throw new HttpError(400, 'date must be YYYY-MM-DD'); vals.push(date); where.push(`a.local_date = $${vals.length}`); }
  if (member_id) { vals.push(member_id); where.push(`a.member_id = $${vals.length}`); }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 100, 300)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT a.*, gm.first_name, gm.last_name, gm.member_code, gm.app_user_id, u.name AS recorded_by_name
     FROM gym_attendance a
     JOIN gym_members gm ON gm.id = a.member_id
     LEFT JOIN users u ON u.id = a.recorded_by
     WHERE ${where.join(' AND ')}
     ORDER BY a.check_in_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows;
}

// The member's ✓/− calendar (spec: Sep 2 ✓ / Sep 1 ✓ / Aug 31 -).
async function memberAttendanceCalendar(gymId, memberId, days = 90) {
  const { rows } = await query(
    `SELECT local_date, source, check_in_at FROM gym_attendance
     WHERE gym_id = $1 AND member_id = $2
       AND local_date >= (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date - $3::int
     ORDER BY local_date DESC`,
    [gymId, memberId, Math.min(days, 365)]
  );
  const present = new Set(rows.map((r) => String(r.local_date)));
  const out = [];
  const todayRows = await query(
    `SELECT (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date AS d`, [gymId]
  );
  let cursor = new Date(`${todayRows.rows[0].d}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const iso = cursor.toISOString().slice(0, 10);
    const rec = rows.find((r) => String(r.local_date) === iso);
    out.push({ date: iso, present: present.has(iso), source: rec ? rec.source : null });
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

// Dashboard: today / week / month counts, peak hours, inactive members.
async function getStats(gymId) {
  const { rows } = await query(
    `WITH tz AS (SELECT (now() AT TIME ZONE g.timezone)::date AS today,
                        (now() AT TIME ZONE g.timezone) AS local_now,
                        g.timezone
                 FROM gyms g WHERE g.id = $1)
     SELECT
       (SELECT COUNT(*)::int FROM gym_attendance a, tz WHERE a.gym_id = $1 AND a.local_date = tz.today) AS today_count,
       (SELECT COUNT(*)::int FROM gym_attendance a, tz WHERE a.gym_id = $1 AND a.local_date > tz.today - 7) AS week_count,
       (SELECT COUNT(*)::int FROM gym_attendance a, tz WHERE a.gym_id = $1 AND a.local_date > tz.today - 30) AS month_count,
       (SELECT json_agg(x) FROM (
          SELECT EXTRACT(HOUR FROM (a.check_in_at AT TIME ZONE tz.timezone))::int AS hour, COUNT(*)::int AS count
          FROM gym_attendance a, tz
          WHERE a.gym_id = $1 AND a.local_date > tz.today - 30
          GROUP BY 1 ORDER BY 2 DESC LIMIT 5
       ) x) AS peak_hours,
       (SELECT json_agg(x) FROM (
          SELECT gm.id AS member_id, gm.first_name, gm.last_name, gm.member_code,
                 MAX(a.local_date) AS last_visit
          FROM gym_members gm
          LEFT JOIN gym_attendance a ON a.member_id = gm.id
          WHERE gm.gym_id = $1 AND gm.status = 'ACTIVE'
          GROUP BY gm.id
          HAVING MAX(a.local_date) IS NULL OR MAX(a.local_date) < tz.today - 14
          ORDER BY last_visit NULLS FIRST
          LIMIT 20
       ) x) AS inactive_members
     FROM tz`,
    [gymId]
  );
  return rows[0];
}

module.exports = {
  SOURCES, ensureQrToken, rotateQrToken, resolveQrToken,
  recordCheckIn, recordOfflineBatch, recordManual, deleteAttendance,
  listAttendance, memberAttendanceCalendar, getStats,
};
