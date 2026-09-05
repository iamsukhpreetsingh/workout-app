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
