// Pure stats helpers. Warmup sets are excluded by callers (SQL filters
// set_type != 'warmup'); NULL rpe values must never be treated as 0.

// Epley estimated 1RM
export const e1rm = (weight, reps) => weight * (1 + reps / 30);

// Average of non-null RPE values only
export function avgRpe(rpes) {
  const valid = rpes.filter((r) => r != null && !isNaN(r));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// Insight for the progress screen: compares recent RPE at a similar weight
export function rpeInsight(rows) {
  // rows: [{ weight, reps, rpe }], most recent last
  const withRpe = rows.filter((r) => r.rpe != null);
  if (withRpe.length < 3) return null;
  const last = rows[rows.length - 1];
  if (!last || last.rpe == null) return null;
  const recent = withRpe.slice(-3);
  const avg = avgRpe(recent.map((r) => r.rpe));
  if (avg <= 7.5) {
    return `Your last ${recent.length} sets averaged RPE ${avg.toFixed(1)} — you may be ready to progress.`;
  }
  if (avg >= 9) {
    return `Your last ${recent.length} sets averaged RPE ${avg.toFixed(1)} — consider holding or reducing load.`;
  }
  return null;
}
