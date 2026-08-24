// Percentage-Based (Training Max) — cycles a percentage of the exercise's
// training max week by week. Requires the user to set a training max
// (ⓘ detail sheet → "Training Max"). If none is set, returns null and the
// caller shows only the historical placeholder plus a one-time prompt.
// Week number = the count of distinct calendar weeks in this exercise's
// recent history, cycling through the configured cycle length.
// NOTE: this formula derives its weight from the per-exercise TRAINING MAX,
// not from logged sets, so multi-weight (ramp/pyramid) sessions don't affect
// it. It only reads history for week counting and the trainingMax stamp.
const r2 = (v) => Math.round(v * 100) / 100;
const weekKey = (t) => {
  const d = new Date(t);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10); // that week's Monday identifies it
};

export default {
  key: 'percentage_based',
  displayName: 'Percentage-Based (Training Max)',
  description: 'Cycles a percentage of your per-exercise training max week by week (e.g. 70% → 80% → 90%). Requires setting a training max on the exercise.',
  requiresTrainingMax: true,
  paramSchema: [
    { key: 'startPercent', label: 'Week 1 percent of max', type: 'number', default: 70, min: 30, max: 95 },
    { key: 'percentStep', label: 'Percent added each week', type: 'number', default: 10, min: 0, max: 20 },
    { key: 'cycleLengthWeeks', label: 'Cycle length (weeks)', type: 'number', default: 3, min: 1, max: 12 },
    { key: 'defaultReps', label: 'Target reps', type: 'number', default: 5, min: 1, max: 20 },
  ],
  calculate(recentHistory, params) {
    if (!Array.isArray(recentHistory) || !recentHistory.length) return null;
    const tm = Number(recentHistory[0].trainingMax);
    if (!tm || tm <= 0) return null; // no training max set → no suggestion

    const start = Number(params?.startPercent ?? 70);
    const step = Number(params?.percentStep ?? 10);
    const cycle = Math.max(1, Number(params?.cycleLengthWeeks ?? 3));
    const reps = Number(params?.defaultReps ?? 5);

    const weeks = new Set(recentHistory.map((s) => weekKey(s.performedAt ?? 0)));
    const weekNumber = ((Math.max(1, weeks.size) - 1) % cycle) + 1;
    const pct = start + step * (weekNumber - 1);

    return {
      suggestedWeight: r2((tm * pct) / 100),
      suggestedReps: reps,
      rationale: `Week ${weekNumber} of ${cycle}: ${pct}% of your ${r2(tm)}kg training max.`,
    };
  },
};