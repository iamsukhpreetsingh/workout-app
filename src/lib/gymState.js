// Gym membership state derivation (Mobile M1) — pure, React-free helpers
// shared by GymContext, MyGymCard and the Gym home screen. Kept free of any
// React Native import so test/runTests.js (plain Node) can exercise them.
//
// All data shaping for the gym foundation lives here so the screens only
// render: the server stays the sole source of truth (rows come from
// /gym/my/memberships and /gym/my/attendance/history, where the caller's
// member rows are resolved from the JWT — never from a client-supplied id).

// Membership-term status → badge color (mirrors the gym-web portal palette).
export const MEMBERSHIP_STATUS_COLORS = {
  ACTIVE: '#16A34A',
  FROZEN: '#D97706',
  UPCOMING: '#5856D6',
  PENDING: '#5856D6',
  EXPIRED: '#78716C',
  CANCELLED: '#DC2626',
};

export function statusColor(status, fallback) {
  return MEMBERSHIP_STATUS_COLORS[status] || fallback;
}

/**
 * Pick the row that represents the user's active gym context.
 *
 * A user can be an app-linked member of several gyms (the backend returns
 * one row per gym, ordered by gym name). Resolution order:
 *   1. the caller's explicit selection (preferredGymId, when still present)
 *   2. the first row whose membership term is ACTIVE
 *   3. the first row at all (PENDING/FROZEN member — still a valid gym
 *      relationship, shown with its own status)
 *
 * @param {Array|null} rows  rows from /gym/my/memberships
 * @param {string|null} [preferredGymId]
 * @returns {object|null}
 */
export function resolveActiveMembershipRow(rows, preferredGymId) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (preferredGymId) {
    const hit = rows.find((r) => r && r.gym_id === preferredGymId);
    if (hit) return hit;
  }
  return rows.find((r) => r && r.membership_status === 'ACTIVE') || rows[0];
}

/**
 * Summarize the 90-day ✓/− attendance calendar of ONE gym into the numbers
 * the Gym home screen shows. READ-ONLY by design: marking attendance is not
 * part of the foundation phase and stays in the existing flows.
 *
 * @param {Array|null} history  [{ date: 'YYYY-MM-DD', present, source }, …]
 *                              newest-first (server builds it that way)
 * @param {string|null} [todayIso]  reference day; defaults to history[0].date
 * @returns {{visits7: number, visits30: number, visitsThisMonth: number, lastVisit: string|null}|null}
 *          null when there is no calendar (no gym selected / fetch pending)
 */
export function summarizeAttendance(history, todayIso) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const today = todayIso || (history[0] && history[0].date);
  if (!today) return null;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(todayMs)) return null;

  const daysAgo = (iso) => (todayMs - Date.parse(`${iso}T00:00:00Z`)) / 86400000;

  let visits7 = 0;
  let visits30 = 0;
  let visitsThisMonth = 0;
  let lastVisit = null;
  const month = String(today).slice(0, 7); // 'YYYY-MM' of the gym-local day
  for (const entry of history) {
    if (!entry || !entry.present) continue;
    const back = daysAgo(entry.date);
    if (Number.isNaN(back) || back < 0) continue; // ignore malformed/future rows
    if (lastVisit === null) lastVisit = entry.date;
    // M5 member home: "18 visits this month" — a count of the ✓ days the
    // SERVER recorded in the current calendar month. Pure display
    // aggregation of server facts; eligibility is still decided server-side.
    if (String(entry.date).slice(0, 7) === month) visitsThisMonth += 1;
    if (back < 30) visits30 += 1;
    if (back < 7) visits7 += 1;
  }
  return { visits7, visits30, visitsThisMonth, lastVisit };
}

// ── M5 member-home display helpers (pure, React-free) ─────────────────────

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "31 Dec 2026" from a gym-local 'YYYY-MM-DD' string (membership expiry,
 * freeze start, class date…). Returns null for absent/invalid values so
 * callers can fall back instead of printing "Invalid Date" or "undefined".
 * Parsed as UTC fields, never via Date string parsing — gym-local dates
 * must not shift with the device timezone.
 */
export function formatDayMonthYear(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return null;
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

// Currency symbols for the money formatter; anything else renders as a
// code prefix ("AUD 25").
const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

// Indian-locale digit grouping WITHOUT relying on Intl (Hermes parity):
// 2500 → '2,500', 250000 → '2,50,000' (last 3, then pairs).
function groupIndian(n) {
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
}

/**
 * Render a server-authoritative amount (integer cents) as display money.
 * Paise are shown only when non-zero (₹2,500 vs ₹2,500.50), matching how
 * the desk ledger quotes membership prices. Never derives anything — the
 * cents and currency both come from the backend.
 */
export function formatMoney(amountCents, currency = 'INR') {
  const cents = Math.round(Number(amountCents) || 0);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  const body = frac
    ? `${groupIndian(whole)}.${String(frac).padStart(2, '0')}`
    : groupIndian(whole);
  return `${sign}${symbol}${body}`;
}

/**
 * The member's next upcoming class at ONE gym (the Upcoming Class card).
 * The server already orders /gym/my/classes by class_date + start_time
 * (soonest first), so this is a filter, not a sort — the client never
 * decides eligibility or scheduling, it just picks the head of the list.
 */
export function pickNextClass(classes, gymId) {
  const rows = Array.isArray(classes) ? classes : [];
  return rows.find((c) => c && (!gymId || c.gym_id === gymId)) || null;
}

/**
 * ALL classes the member actually holds a BOOKED seat in, at ONE gym — the
 * My Gym "Upcoming Classes" list. Enrolled-only by design: enrolled in 2 of
 * 10 classes → exactly those 2 rows surface here; the full schedule lives
 * on the Classes screen and is never echoed by the dashboard. A waitlisted
 * spot is not a seat and never surfaces in the list (callers may mention
 * the waitlist count in their empty state / footnote). The server already
 * orders /gym/my/classes by class_date + start_time and only sends upcoming
 * rows, so this is a filter, not a sort — the client never decides
 * eligibility or scheduling.
 */
export function myBookedClasses(classes, gymId) {
  const rows = Array.isArray(classes) ? classes : [];
  return rows.filter((c) => c && c.my_status === 'BOOKED' && (!gymId || c.gym_id === gymId));
}

/**
 * One gym's billing slice (the Payments card). Null when that gym has no
 * charges at all — the card renders "all settled".
 */
export function billingForGym(rows, gymId) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find((r) => r && r.gym_id === gymId) || null;
}

/**
 * One gym's trainer slice (the Trainer card). Null when no row — same
 * "not assigned" rendering as an explicit null trainer_name.
 */
export function trainerForGym(rows, gymId) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find((r) => r && r.gym_id === gymId) || null;
}

/**
 * The source line for the RESOLVED active trainer (fetchMyActiveTrainer):
 *   GYM  → "Assigned by <gym>"     (the portal decides, not the user)
 *   USER → "Connected trainer"     (invite-code relationship)
 *   USER pending → "Request sent — waiting to accept"
 * Null when no trainer — callers render their own empty state. Pure display
 * aggregation of server facts, exactly like the attendance labels.
 */
export function activeTrainerSourceLine(t) {
  if (!t || !t.trainer) return null;
  if (t.source === 'GYM') {
    return t.gym && t.gym.name ? `Assigned by ${t.gym.name}` : 'Assigned by your gym';
  }
  if (t.status === 'pending') return 'Request sent — waiting to accept';
  return 'Connected trainer';
}

// ── M6 attendance experience (pure, React-free) ───────────────────────────
// Everything the history screen and check-in flow DISPLAY is derived here
// from server facts (the ✓/− calendar, the gym's local `today`). The client
// never decides eligibility and never derives a date from the device clock.

// Recorded visit sources → the short label shown on ✓ days.
export const ATTENDANCE_SOURCE_LABELS = {
  QR_CHECK_IN: 'QR check-in',
  FRONT_DESK: 'Front desk',
  WORKOUT_COMPLETION: 'Workout',
  ADMIN_MANUAL: 'Added by gym',
};

export function attendanceSourceLabel(source) {
  return ATTENDANCE_SOURCE_LABELS[source] || null;
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-09' → 'September 2026' (null for junk — callers fall back). */
export function monthLabel(ym) {
  const [y, m] = String(ym || '').slice(0, 7).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return `${MONTHS_FULL[m - 1]} ${y}`;
}

function daysInMonth(ym) {
  const [y, m] = String(ym || '').slice(0, 7).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return 0;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Months the fetched window can honestly render, newest first, never past
 * the gym-local today. The window starts at the OLDEST row the server sent
 * (history is newest-first), so months before that stay unlisted.
 */
export function availableMonths(history, todayIso) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const today = String(todayIso || (history[0] && history[0].date) || '').slice(0, 10);
  if (!ISO_RE.test(today)) return [];
  const oldest = history.reduce(
    (min, e) => (e && ISO_RE.test(String(e.date)) && String(e.date) < min ? String(e.date) : min),
    today
  );
  const months = [];
  let [y, m] = oldest.slice(0, 7).split('-').map(Number);
  const [ty, tm] = today.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months.reverse();
}

/**
 * One month's ✓/− rows for the history screen:
 *   state 'present' ✓ (with sourceLabel when the server recorded one),
 *   'absent' − (inside the fetched window, no visit),
 *   'future'  · (after the gym-local today — the month is still running),
 *   'unknown' · (before the fetched window begins — honestly not "no visit").
 * Days are 1..N of the month regardless of window, so the calendar reads
 * like a real month.
 */
export function attendanceMonthRows(history, ym, todayIso) {
  if (!Array.isArray(history) || history.length === 0) return [];
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return [];
  const today = String(todayIso || (history[0] && history[0].date) || '').slice(0, 10);
  if (!ISO_RE.test(today)) return [];
  const oldestFetched = String(history[history.length - 1].date || '');
  const byDate = new Map();
  for (const e of history) {
    if (e && ISO_RE.test(String(e.date))) byDate.set(String(e.date), e);
  }
  const n = daysInMonth(ym);
  const rows = [];
  for (let d = 1; d <= n; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const entry = byDate.get(iso);
    let state = 'absent';
    if (entry) state = entry.present ? 'present' : 'absent';
    else if (today && iso > today) state = 'future';
    else if (oldestFetched && iso < oldestFetched) state = 'unknown';
    rows.push({
      day: d,
      iso,
      state,
      sourceLabel: state === 'present' ? attendanceSourceLabel(entry.source) : null,
    });
  }
  return rows;
}

/**
 * Headline numbers for the history screen — display aggregation of server
 * facts only (eligibility stays server-side, as always).
 *   total     — every ✓ day in the fetched window
 *   thisMonth — ✓ days in the gym-local current month
 *   streak    — consecutive ✓ days ending today or yesterday (gym-local);
 *               0 when the last visit is older than yesterday
 *   longest   — longest ✓ run inside the fetched window
 */
export function attendanceStats(history, todayIso) {
  const empty = { total: 0, thisMonth: 0, streak: 0, longest: 0 };
  if (!Array.isArray(history) || history.length === 0) return empty;
  const today = String(todayIso || (history[0] && history[0].date) || '').slice(0, 10);
  if (!ISO_RE.test(today)) return empty;

  const present = history
    .filter((e) => e && e.present && ISO_RE.test(String(e.date)) && String(e.date) <= today)
    .map((e) => String(e.date))
    .sort(); // ascending

  const month = today.slice(0, 7);
  let total = 0;
  let thisMonth = 0;
  for (const iso of present) {
    total += 1;
    if (iso.slice(0, 7) === month) thisMonth += 1;
  }

  let longest = 0;
  let run = 0;
  let prevMs = null;
  for (const iso of present) {
    const ms = Date.parse(`${iso}T00:00:00Z`);
    run = prevMs !== null && ms - prevMs === 86400000 ? run + 1 : 1;
    if (run > longest) longest = run;
    prevMs = ms;
  }

  let streak = 0;
  if (present.length) {
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    const lastMs = Date.parse(`${present[present.length - 1]}T00:00:00Z`);
    const gap = (todayMs - lastMs) / 86400000;
    if (gap === 0 || gap === 1) {
      streak = 1;
      for (let i = present.length - 1; i > 0; i--) {
        const a = Date.parse(`${present[i]}T00:00:00Z`);
        const b = Date.parse(`${present[i - 1]}T00:00:00Z`);
        if (a - b === 86400000) streak += 1;
        else break;
      }
    }
  }

  return { total, thisMonth, streak, longest };
}

/**
 * The poster payload → the code the backend expects. Scans arrive as
 * gymcheckin:v1:<code>; typed entry is usually already the bare code.
 * Null for anything that cannot possibly be a code (empty / absurd length)
 * so the screen can refuse to submit instead of round-tripping junk.
 */
export function normalizeCheckInCode(raw) {
  const code = String(raw || '')
    .replace(/\s+/g, '')
    .replace(/^gymcheckin:v1:/i, '');
  return code.length >= 8 && code.length <= 128 ? code.toLowerCase() : null;
}

/**
 * ── Mobile M11: attendance payment warning (pure, React-free) ───────────
 * Derives the warning shown at check-in / workout completion from the
 * server's /gym/my/billing slice. WARNING ONLY — never a block: attendance
 * stays recorded and idempotent regardless.
 *   DUE     → "₹1,499 is due (due date)"
 *   OVERDUE → "₹1,499 overdue by N days"
 *   PENDING_VERIFICATION proof → different copy ("being reviewed")
 * Returns null when there is nothing outstanding or the data doesn't cover
 * the gym.
 */
export function paymentWarningForGym(billingRows, gymId, todayIso) {
  const b = billingForGym(billingRows, gymId);
  if (!b) return null;
  const open = (b.charges || []).filter((c) => c && ['DUE', 'OVERDUE', 'PARTIAL'].includes(c.status));
  if (!open.length || !b.outstanding_cents) return null;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const overdue = b.overdue_cents > 0;
  const earliest = open.reduce((acc, c) => (
    !acc || String(c.due_on) < acc ? String(c.due_on) : acc), null);
  const overdueDays = overdue && earliest
    ? Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${earliest}T00:00:00Z`)) / 86400000))
    : 0;
  return {
    outstanding_cents: b.outstanding_cents,
    currency: b.currency || 'INR',
    overdue,
    overdue_days: overdueDays,
    next_due_on: b.next_due_on || earliest,
    pending_proof: false,
  };
}
