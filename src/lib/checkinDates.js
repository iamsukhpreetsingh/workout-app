// Pure helpers for diet/supplement plan check-ins. No React Native imports —
// this module runs under plain Node so test/runTests.js can regression-test
// it directly (see the check-in independence tests at the bottom of that
// file).
//
// WHY THIS EXISTS: the original implementation kept ONE checkedToday value
// per plan and always wrote real-today, so checking in on one date bled
// into every other date's display. State must be keyed per exact calendar
// date, future dates must never be loggable, and "today" must come from the
// device's LOCAL calendar (not toISOString(), which is UTC and mislabels
// today near midnight in non-UTC timezones).

// Local calendar date as YYYY-MM-DD. Deliberately NOT
// new Date().toISOString().slice(0, 10): that is UTC-based and returns the
// WRONG day for local times between midnight and 1am in e.g. UTC+5:30
// (or after 11pm in UTC-8). Timezone-boundary safety was an explicit
// acceptance criterion for the check-in feature.
export function todayLocalISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// True when dateStr is strictly AFTER today (date-only comparison).
// Zero-padded YYYY-MM-DD strings compare correctly lexicographically, which
// avoids every time-of-day / timezone-boundary pitfall: at 11:58 PM local,
// today is still NOT a future date; at 00:01 AM, tomorrow still is.
export function isFutureDate(dateStr, today = todayLocalISO()) {
  return String(dateStr || '').slice(0, 10) > String(today).slice(0, 10);
}

// Build { 'YYYY-MM-DD': boolean } from check-in rows. Handles BOTH row
// shapes: API rows (followed/taken true/false or null) and local SQLite rows
// (followed/taken 1/0). doneCol selects 'followed' (diet) or 'taken'
// (supplement). Rows missing the column are skipped rather than coerced to
// false — absence of data must read as UNANSWERED, never as "No".
export function buildCheckinMap(rows, doneCol = 'followed') {
  const map = {};
  for (const c of rows || []) {
    if (!c || !c.date) continue;
    const key = String(c.date).slice(0, 10);
    let val = c[doneCol];
    if (val == null && doneCol === 'taken' && 'followed' in c) val = c.followed;
    if (val === null || val === undefined) continue;
    map[key] = val === true || val === 1;
  }
  return map;
}
