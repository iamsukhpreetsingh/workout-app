// gymDashboard.js — Gym Management business dashboard (Phase 15).
//
// ONE read endpoint, ALL aggregation in SQL (COUNT/SUM/GROUP BY/FILTER —
// never row loads into JS), EVERY query gym-scoped by gym_id. Represents
// ALL GymMembers — app-connected and non-app alike (app_user_id NULL rows
// count everywhere; the app is a delivery channel, not a membership).
//
// SECTIONS:
//   members      status buckets (ACTIVE/FROZEN/EXPIRED/CANCELLED/PENDING),
//                total, expiring-soon window
//   app_adoption connected / not connected / invitation pending (subset of
//                not connected), over the non-CANCELLED member base
//   financial    net collected (payments − additive refunds), this month,
//                outstanding charges (DUE/PARTIAL derivation lives in the
//                ledger — here it is just amount − net-paid), overdue slice
//   attendance   today / week / month visits on gym-local calendar days,
//                peak hours over the last 30 gym-local days, inactive
//                members (no visit in the window, incl. never visited)
//   trainers     active TRAINER staff, roster coverage, unassigned members
//   branches     per-branch split when the gym labels members (multiple
//                branches are just data — there is no branch entity)
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

async function dashboard(gymId) {
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

  const [
    memberBuckets, adoption, expiring, collected, refunds,
    outstanding, attendance, peakRows, inactive, trainerRows, branchRows, currencyRow,
  ] = await Promise.all([
    // ── members: one row per status ──
    query(
      `SELECT status, COUNT(*)::int AS n FROM gym_members
       WHERE gym_id = $1 GROUP BY status`,
      [gymId]
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
       FROM gym_members WHERE gym_id = $1 AND status <> 'CANCELLED'`,
      [gymId]
    ),
    // ── memberships expiring soon (ACTIVE term, ends within the window) ──
    query(
      `SELECT COUNT(DISTINCT member_id)::int AS n FROM member_memberships
       WHERE gym_id = $1 AND status = 'ACTIVE'
         AND ends_on >= $2 AND ends_on <= $3`,
      [gymId, today, expiringEnd]
    ),
    // ── net collected: receipts minus additive refunds (immutably honest) ──
    query(
      `SELECT
         COALESCE(SUM(p.amount_cents), 0)::int AS gross,
         COALESCE(SUM(p.amount_cents) FILTER (WHERE p.paid_on >= $2), 0)::int AS gross_month
       FROM membership_payments p WHERE p.gym_id = $1`,
      [gymId, monthStart]
    ),
    query(
      `SELECT COALESCE(SUM(r.amount_cents), 0)::int AS refunded
       FROM payment_refunds r WHERE r.gym_id = $1`,
      [gymId]
    ),
    // ── outstanding charges: amount − (payments − refunds on those payments) ──
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
         FROM membership_charges c WHERE c.gym_id = $1
       )
       SELECT
         COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0), 0)::int AS outstanding,
         COALESCE(SUM(outstanding_cents) FILTER (WHERE outstanding_cents > 0 AND due_on < $2), 0)::int AS overdue,
         COUNT(*) FILTER (WHERE outstanding_cents > 0)::int AS open_charges,
         COUNT(*) FILTER (WHERE outstanding_cents > 0 AND due_on < $2)::int AS overdue_charges
       FROM net`,
      [gymId, today]
    ),
    // ── attendance on gym-local calendar days ──
    query(
      `SELECT
         COUNT(*) FILTER (WHERE local_date = $2)::int AS today,
         COUNT(*) FILTER (WHERE local_date BETWEEN $3 AND $2)::int AS week,
         COUNT(*) FILTER (WHERE local_date >= $4 AND local_date <= $5)::int AS month
       FROM gym_attendance WHERE gym_id = $1`,
      [gymId, today, weekStart, monthStart, monthEnd]
    ),
    // ── peak hours: check-in CLOCK HOUR in the gym's timezone ──
    query(
      `SELECT EXTRACT(HOUR FROM check_in_at AT TIME ZONE $2)::int AS hour,
              COUNT(*)::int AS visits
       FROM gym_attendance
       WHERE gym_id = $1 AND local_date >= $3 AND local_date <= $4
       GROUP BY 1`,
      [gymId, tz, peakStart, today]
    ),
    // ── inactive members: no visit in the window, never-visited included ──
    query(
      `SELECT COUNT(*)::int AS n FROM gym_members m
       WHERE m.gym_id = $1 AND m.status <> 'CANCELLED'
         AND NOT EXISTS (
           SELECT 1 FROM gym_attendance a
           WHERE a.member_id = m.id AND a.local_date >= $2
         )`,
      [gymId, inactiveCutoff]
    ),
    // ── trainers + roster coverage ──
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM gym_staff
           WHERE gym_id = $1 AND gym_role = 'TRAINER' AND status = 'ACTIVE') AS total_trainers,
         (SELECT COUNT(DISTINCT member_id)::int FROM gym_trainer_assignments
           WHERE gym_id = $1 AND status = 'ACTIVE') AS assigned_members,
         (SELECT COUNT(*)::int FROM gym_members
           WHERE gym_id = $1 AND status <> 'CANCELLED') AS member_base`,
      [gymId]
    ),
    // ── per-branch split (free-form labels; only when the gym uses them) ──
    query(
      `SELECT branch, COUNT(*)::int AS members,
              COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active
       FROM gym_members
       WHERE gym_id = $1 AND status <> 'CANCELLED' AND branch IS NOT NULL
       GROUP BY branch ORDER BY members DESC LIMIT 20`,
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
    generated_at: new Date().toISOString(),
    as_of_local: nowLocal,
  };
}

module.exports = { dashboard, INACTIVE_WINDOW_DAYS, EXPIRING_SOON_DAYS };
