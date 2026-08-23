// Linear Progression — the app default.
//
// HISTORY CONTRACT (shared by ALL formulas): calculate() receives a FLAT
// array of working-set objects from this exercise's last 1–3 sessions,
// most recent SESSION first, sets in performed order:
//   { weight, reps, targetReps, completed, rpe, sessionIndex, trainingMax, performedAt }
//   sessionIndex: 0 = most recent session, 1 = the one before, …
//   targetReps:   the session's reps target (its opening working set's reps)
//   trainingMax:  per-exercise training max, stamped on every set by the caller
// Blank placeholder rows (no weight/reps, not completed) are filtered out by
// the caller. Returns { suggestedWeight, suggestedReps, rationale } — or
// null when there's no usable history. Callers MUST treat null as "show no
// suggestion", never an error or a zero.
const r2 = (v) => Math.round(v * 100) / 100;

export default {
  key: 'linear_progression',
  displayName: 'Linear Progression',
  description: 'Adds a fixed weight increment each time all target sets/reps are hit.',
  paramSchema: [
    { key: 'incrementKg', label: 'Weight increase (kg)', type: 'number', default: 2.5, min: 0.5, max: 20 },
    { key: 'requireAllSetsHit', label: 'Require all sets at target reps', type: 'boolean', default: true },
  ],
  calculate(recentHistory, params) {
    if (!Array.isArray(recentHistory) || !recentHistory.length) return null;
    const increment = Number(params?.incrementKg ?? 2.5);
    const requireAll = params?.requireAllSetsHit !== false;

    const last = recentHistory.filter((s) => (s.sessionIndex ?? 0) === 0);
    if (!last.length) return null;

    const lastWeight = Number(last[0].weight) || 0;
    const targetReps = last[0].targetReps ?? last[0].reps ?? 0;
    const allHit = last.every((s) => s.completed && (s.reps ?? 0) >= (s.targetReps ?? targetReps));
    const advance = requireAll ? allHit : true;

    return {
      suggestedWeight: r2(advance ? lastWeight + increment : lastWeight),
      suggestedReps: targetReps,
      rationale: advance
        ? `All ${last.length} set${last.length === 1 ? '' : 's'} hit ${targetReps} reps at ${r2(lastWeight)}kg — add ${increment}kg.`
        : `Didn't hit every set last time — repeat ${r2(lastWeight)}kg.`,
    };
  },
};