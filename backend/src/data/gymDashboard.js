// gymDashboard.js — Gym Management business dashboard (Phase 15, extended
// for multi-branch in Phase 16).
//
// ONE read endpoint, ALL aggregation in SQL (COUNT/SUM/GROUP BY/FILTER —
// never row loads into JS), EVERY query gym-scoped by gym_id. Represents
// ALL GymMembers — app-connected and non-app alike (app_user_id NULL rows
// count everywhere; the app is a delivery channel, not a membership).
//
// BRANCH FILTER (Phase 16): ?branch_id= scopes the KPIs to one branch —
//   members / adoption / financial / inactive: members whose PRIMARY branch
//     is the branch (legacy members with no primary only appear in All).
//   attendance: visits TAGGED with that branch (branch-specific attendance).
//   trainers: staff who can operate there (unrestricted or listed), with the
//     assignments of that branch's primary members.
//   All without branch_id = the whole gym. The `branches` array always
//   returns the full per-branch split (entity rows with id/name/status) so
//   the UI can render the [All Branches ▼] selector and the table at once.
//
// SECTIONS:
//   members      status buckets (ACTIVE/FROZEN/EXPIRED/CANCELLED/PENDING),
//                total, expiring-soon window
//   app_adoption connected / not connected / invitation pending (subset of
//                not connected), over the non-CANCELLED member base
//   financial    net collected (payments − additive refunds), this month,
//                outstanding charges (amount − net-paid), overdue slice
//   attendance   today / week / month visits on gym-local calendar days,
//                peak hours over the last 30 gym-local days, inactive
//                members (no visit in the window, incl. never visited)
//   trainers     active TRAINER staff, roster coverage, unassigned members
//   branches     per-branch split (real branches since Phase 16)
//
// EDGE CASES (all answered with zeros / empty arrays, never NaN):
//   new gym, zero members, zero revenue, zero attendance, only non-app
//   members, only app members, mixed members, incomplete history.
//
// TIME: every "today/week/month/peak" answer uses the GYM's timezone
// (gym-local calendar days / clock hours), never the server clock.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INACTIVE_WINDOW_DAYS = 7;   // "Members Inactive 7+ Days"
const EXPIRING_SOON_DAYS = 7;     // memberships ending within a week
const PEAK_HOURS_WINDOW_DAYS = 30;

// ── gym-local calendar helpers (same semantics as attendance local_date) ──
async function gymTz(gymId) {
  const { rows } = await query('SELECT timezone FROM gyms WHERE id = $1', [gymId]);
  if (!rows.length) throw new HttpError(404, 'Gym not found');
  return rows[0].timezone;
}

// "YYYY-MM-DD" in the gym's timezone
function localDateIn(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// shift a YYYY-MM-DD date by N days (UTC arithmetic on the date string is
// exact — no DST drift for calendar-day math)
function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function dashboard(gymId, branchId = null) {
  const tz = await gymTz(gymId);
  const today = localDateIn(tz);
  const weekStart = shiftDate(today, -6);                            // 7 days incl today
  const monthStart = `${today.slice(0, 7)}-01`;                      // gym-local month
  const monthEnd = shiftDate(shiftDate(monthStart, 32).slice(0, 7) + '-01', -1);
  const expiringEnd = shiftDate(today, EXPIRING_SOON_DAYS - 1);
  const inactiveCutoff = shiftDate(today, -INACTIVE_WINDOW_DAYS + 1); // "within last 7 days"
  const peakStart = shiftDate(today, -PEAK_HOURS_WINDOW_DAYS + 1);
  const nowLocal = `${today} ${new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date())}`;

  // branch filter setup: validated + two bind values reused by every query
  let branchFilter = null;
  if (branchId) {
    if (!UUID_RE.test(String(branchId))) throw new HttpError(400, 'branch_id must be a branch id');
    const { rows } = await query(
      'SELECT id, name, status FROM gym_branches WHERE id = $1 AND gym_id = $2',
      [branchId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Branch not found');
    branchFilter = rows[0];
  }
  // every query binds $2 = the branch filter (NULL = All Branches); the
  // WHERE clauses short-circuit on `$2::uuid IS NULL OR ...`
  const bf = branchFilter ? branchFilter.id : null;

  const [
    memberBuckets, adoption, expiring, collected, refunds,
    outstanding, attendance, peakRows, inactive, trainerRows, branchRows, currencyRow,
  ] = await Promise.all([
    // ── members: one row per status ──
    query(
      `SELECT status, COUNT(*)::int AS n FROM gym_members
       WHERE gym_id = $1
         AND ($2::uuid IS NULL OR primary_branch_id = $2::uuid)
       GROUP BY status`,
      [gymId, bf]
    ),
    // ── app adoption over the non-CANCELLED base ──
    // Spec semantics: Total = Connected + Not Connected, with "invitation
    // pending" a SUBSET of Not Connected (an invited member is still not
    // connected until they actually link the app).
    query(
      `SELECT
         COUNT(*) FILTER (WHERE app_user_id IS NOT NULL)::int AS connected,
         COUNT(*) FILTER (WHERE app_user_id IS NULL)::int AS not_connected,
         COUNT(*) FILTER (WHERE app_user_id IS NULL
                           AND app_invite_status = 'pending')::int AS invitation_pending
       FROM gym_members
       WHERE gym_id = $1 AND status <> 'CANCELLED'
         AND ($2::uuid IS NULL OR primary_branch_id = $2::uuid)`,
      [gymId, bf]
    ),
    // ── memberships expiring soon (ACTIVE term, ends within the window) ──
    query(
      `SELECT COUNT(DISTINCT t.member_id)::int AS n FROM member_memberships t
       JOIN gym_members m ON m.id = t.member_id
       WHERE t.gym_id = $1 AND t.status = 'ACTIVE'
         AND t.ends_on >= $3 AND t.ends_on <= $4
         AND ($2::uuid IS NULL OR m.primary_branch_id = $2::uuid)`,
      [gymId, bf, today, expiringEnd]
    ),
    // ── net collected: receipts minus additive refunds (immutably honest);
    //     attributed to the payer's PRIMARY branch ──
    query(
      `SELECT
         COALESCE(SUM(p.amount_cents), 0)::int AS gross,
         COALESCE(SUM(p.amount_cents) FILTER (WHERE p.paid_on >= $3), 0)::int AS gross_month
       FROM membership_payments p
       WHERE p.gym_id = $1
         AND ($2::uuid IS NULL OR EXISTS (
           SELECT 1 FROM gym_members m
           WHERE m.id = p.member_id AND m.primary_branch_id = $2::uuid))`,
      [gymId, bf, monthStart]
    ),
    query(
      `SELECT COALESCE(SUM(r.amount_cents), 0)::int AS refunded
       FROM payment_refunds r
       WHERE r.gym_id = $1
         AND ($2::uuid IS NULL OR EXISTS (
           SELECT 1 FROM membership_payments p
           JOIN gym_members m ON m.id = p.member_id
           WHERE p.id = r.payment_id AND m.primary_branch_id = $2::uuid))`,
      [gymId, bf]
    ),
    // ── outstanding charges: amount − (payments − refunds on those payments),
    //     attributed to the charged member's PRIMARY branch ──
    query(
      `WITH net AS (
         SELECT c.amount_cents, c.due_on,
                c.amount_cents - COALESCE((
                  SELECT SUM(p.amount_cents - COALESCE(pr.refunded, 0))
                  FROM membership_payments p
                  LEFT JOIN (
                    SELECT payment_id, SUM(amount_cents) AS refunded
                    FROM payment_refunds GROUP BY payment_id
                  ) pr ON pr.payment_id = p.id
                  WHERE p.charge_id = c.id
                ), 0) AS outstanding_cents
         FROM membership_charges c
         WHERE c.gym_id = $1
           AND ($2::uuid IS NULL OR EXISTS (
             SELECT 1 FROM gym_members m
             WHERE m.id = c.member_id AND m.primary_branch_id = $2::uuid))
       )
       SELECT
         COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0), 0)::int AS outstanding,
         COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0 AND due_on < $3), 0)::int AS overdue,
         COUNT(*) FILTER (WHERE outstanding_cents > 0)::int AS open_charges,
         COUNT(*) FILTER (WHERE outstanding_cents > 0 AND due_on < $3)::int AS overdue_charges
       FROM net`,
      [gymId, bf, today]
    ),
    // ── attendance on gym-local calendar days, tagged by branch ──
    query(
      `SELECT
         COUNT(*) FILTER (WHERE local_date = $3)::int AS today,
         COUNT(*) FILTER (WHERE local_date BETWEEN $4 AND $3)::int AS week,
         COUNT(*) FILTER (WHERE local_date >= $5 AND local_date <= $3)::int AS month
       FROM gym_attendance
       WHERE gym_id = $1
         AND ($2::uuid IS NULL OR branch_id = $2::uuid)`,
      [gymId, bf, today, weekStart, monthStart]
    ),
    // ── peak hours: check-in CLOCK HOUR in the gym's timezone ──
    query(
      `SELECT EXTRACT(HOUR FROM check_in_at AT TIME ZONE $3)::int AS hour,
              COUNT(*)::int AS visits
       FROM gym_attendance
       WHERE gym_id = $1
         AND ($2::uuid IS NULL OR branch_id = $2::uuid)
         AND local_date >= $4 AND local_date <= $5
       GROUP BY 1`,
      [gymId, bf, tz, peakStart, today]
    ),
    // ── inactive members: no visit in the window, never-visited included ──
    query(
      `SELECT COUNT(*)::int AS n FROM gym_members m
       WHERE m.gym_id = $1 AND m.status <> 'CANCELLED'
         AND ($2::uuid IS NULL OR m.primary_branch_id = $2::uuid)
         AND NOT EXISTS (
           SELECT 1 FROM gym_attendance a
           WHERE a.member_id = m.id AND a.local_date >= $3
         )`,
      [gymId, bf, inactiveCutoff]
    ),
    // ── trainers + roster coverage. In a branch view a trainer counts when
    //     they can operate there (unrestricted OR listed in branch_ids). ──
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM gym_staff
           WHERE gym_id = $1 AND gym_role = 'TRAINER' AND status = 'ACTIVE'
             AND ($2::uuid IS NULL
                  OR branch_ids = '{}'
                  OR branch_ids @> ARRAY[$2::uuid])) AS total_trainers,
         (SELECT COUNT(DISTINCT ta.member_id)::int FROM gym_trainer_assignments ta
           JOIN gym_members m ON m.id = ta.member_id
           WHERE ta.gym_id = $1 AND ta.status = 'ACTIVE'
             AND ($2::uuid IS NULL OR m.primary_branch_id = $2::uuid)) AS assigned_members,
         (SELECT COUNT(*)::int FROM gym_members
           WHERE gym_id = $1 AND status <> 'CANCELLED'
             AND ($2::uuid IS NULL OR primary_branch_id = $2::uuid)) AS member_base`,
      [gymId, bf]
    ),
    // ── per-branch split: REAL branches (Phase 16). Always the full list so
    //     the UI can render the selector + table from one payload. ──
    query(
      `SELECT b.id, b.name, b.status,
              COUNT(m.id) FILTER (WHERE m.id IS NOT NULL)::int AS members,
              COUNT(m.id) FILTER (WHERE m.status = 'ACTIVE')::int AS active
       FROM gym_branches b
       LEFT JOIN gym_members m
         ON m.primary_branch_id = b.id AND m.status <> 'CANCELLED'
       WHERE b.gym_id = $1
       GROUP BY b.id, b.name, b.status
       ORDER BY (b.status = 'ACTIVE') DESC, members DESC, b.name`,
      [gymId]
    ),
    query('SELECT currency FROM gyms WHERE id = $1', [gymId]),
  ]);

  const buckets = { ACTIVE: 0, PENDING: 0, FROZEN: 0, EXPIRED: 0, CANCELLED: 0 };
  let total = 0;
  for (const { status, n } of memberBuckets.rows) {
    buckets[status] = (buckets[status] ?? 0) + n;
    total += n;
  }

  // peak hour = argmax, earliest hour wins ties; 24-bucket series for charts
  const peak = new Array(24).fill(0);
  for (const { hour, visits } of peakRows.rows) {
    if (hour >= 0 && hour <= 23) peak[hour] += visits;
  }
  let peakHour = null;
  for (let h = 0; h < 24; h += 1) {
    if (peak[h] > 0 && (peakHour === null || peak[h] > peak[peakHour])) peakHour = h;
  }

  return {
    members: {
      total,
      active: buckets.ACTIVE,
      pending: buckets.PENDING,
      frozen: buckets.FROZEN,
      expired: buckets.EXPIRED,
      cancelled: buckets.CANCELLED,
      expiring_soon_7d: expiring.rows[0].n,
    },
    app_adoption: {
      total: adoption.rows[0].connected + adoption.rows[0].not_connected,
      connected: adoption.rows[0].connected,
      not_connected: adoption.rows[0].not_connected,
      invitation_pending: adoption.rows[0].invitation_pending,
    },
    financial: {
      currency: currencyRow.rows[0]?.currency || 'INR',
      collected_cents: collected.rows[0].gross - refunds.rows[0].refunded,
      refunded_cents: refunds.rows[0].refunded,
      collected_month_cents: collected.rows[0].gross_month,
      outstanding_cents: outstanding.rows[0].outstanding,
      overdue_cents: outstanding.rows[0].overdue,
      open_charges: outstanding.rows[0].open_charges,
      overdue_charges: outstanding.rows[0].overdue_charges,
    },
    attendance: {
      today: attendance.rows[0].today,
      week: attendance.rows[0].week,
      month: attendance.rows[0].month,
      peak_hours: peak.map((visits, hour) => ({ hour, visits })),
      peak_hour: peakHour,
      peak_window_days: PEAK_HOURS_WINDOW_DAYS,
      inactive_7d: inactive.rows[0].n,
      inactive_window_days: INACTIVE_WINDOW_DAYS,
    },
    trainers: {
      total: trainerRows.rows[0].total_trainers,
      assigned_members: trainerRows.rows[0].assigned_members,
      unassigned_members: Math.max(
        0, trainerRows.rows[0].member_base - trainerRows.rows[0].assigned_members
      ),
      members_per_trainer: trainerRows.rows[0].total_trainers > 0
        ? Math.round(
            (trainerRows.rows[0].assigned_members / trainerRows.rows[0].total_trainers) * 10
          ) / 10
        : 0,
    },
    branches: branchRows.rows,
    branch_filter: branchFilter
      ? { id: branchFilter.id, name: branchFilter.name, status: branchFilter.status }
      : null,
    generated_at: new Date().toISOString(),
    as_of_local: nowLocal,
  };
}

module.exports = { dashboard, INACTIVE_WINDOW_DAYS, EXPIRING_SOON_DAYS };
