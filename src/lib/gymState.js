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
 * @returns {{visits7: number, visits30: number, lastVisit: string|null}|null}
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
  let lastVisit = null;
  for (const entry of history) {
    if (!entry || !entry.present) continue;
    const back = daysAgo(entry.date);
    if (Number.isNaN(back) || back < 0) continue; // ignore malformed/future rows
    if (lastVisit === null) lastVisit = entry.date;
    if (back < 30) visits30 += 1;
    if (back < 7) visits7 += 1;
  }
  return { visits7, visits30, lastVisit };
}
