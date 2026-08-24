// Linear Progression — the app default.
//
// HISTORY CONTRACT (shared by ALL formulas): calculate() receives a FLAT
// array of working-set objects from this exercise's last 1–3 sessions,
// most recent SESSION first, sets in performed order:
//   { weight, reps, targetReps, completed, rpe, setType, sessionIndex, trainingMax, performedAt }
//   sessionIndex: 0 = most recent session, 1 = the one before, …
//   setType:      'working' | 'warmup' | 'dropset' | 'failure'
//   trainingMax:  per-exercise training max, stamped on every set by the caller
// Blank placeholder rows (no weight/reps, not completed) are filtered out by
// the caller. Returns { suggestedWeight, suggestedReps, rationale } — or
// null when there's no usable history. Callers MUST treat null as "show no
// suggestion", never an error or a zero.
//
// WEIGHT-GROUPING RULE: sets within one exercise entry may span multiple
// distinct working weights (ramp/pyramid structure) — always group by weight
// (see weightGroups.js) and evaluate ONLY the top weight group; never assume
// all sets in an exercise share one target weight. The suggestion is always
// based on the top group's own weight — the fallback is to repeat it, never
// to fall back to a lighter ramp-set weight.
import { topWeightGroup } from './weightGroups.js';

const r2 = (v) => Math.round(v * 100) / 100;

export default {
  key: 'linear_progression',
  displayName: 'Linear Progression',
  description: 'Adds a fixed weight increment each time all target sets/reps are hit.',
  paramSchema: [
    { key: 'incrementKg', label: 'Weight increase (kg)', type: 'number', default: 2.5, min: 0.5, max: 20 },
    { key: 'repThreshold', label: 'Reps needed before adding weight', type: 'number', default: 10, min: 1, max: 30 },
    { key: 'requireAllSetsHit', label: 'Require all sets at target reps', type: 'boolean', default: true },
  ],
  calculate(recentHistory, params) {
    if (!Array.isArray(recentHistory) || !recentHistory.length) return null;
    const increment = Number(params?.incrementKg ?? 2.5);
    // Reps-before-weight: weight only goes up once the top group reaches
    // repThreshold reps; below it, repeat the same weight with +1 rep.
    const threshold = Number(params?.repThreshold ?? 10);
    const requireAll = params?.requireAllSetsHit !== false;

    // TOP weight group only — lighter ramp groups are never evaluated.
    const group = topWeightGroup(recentHistory);
    if (!group.length) return null;

    const lastWeight = Number(group[0].weight) || 0;
    // The rep target is the top group's OWN demonstrated performance (its
    // best set), not a blended value across weights.
    const targetReps = Math.max(...group.map((s) => s.reps ?? 0));

    // Below the rep threshold → same weight, +1 rep (all sets must have hit
    // the group's best; otherwise just repeat and aim for the best again).
    if (targetReps < threshold) {
      const allHit = group.every((s) => s.completed && (s.reps ?? 0) >= targetReps);
      const nextReps = requireAll && !allHit ? targetReps : targetReps + 1;
      return {
        suggestedWeight: r2(lastWeight),
        suggestedReps: nextReps,
        rationale:
          nextReps === targetReps + 1
            ? `Add a rep before adding weight — ${r2(lastWeight)}kg × ${nextReps} next time.`
            : `Didn't hit every set at ${r2(lastWeight)}kg last time — repeat ${r2(lastWeight)}kg and aim for ${nextReps} reps.`,
      };
    }

    // At/above the rep threshold → add weight at the same rep count.
    return {
      suggestedWeight: r2(lastWeight + increment),
      suggestedReps: targetReps,
      rationale: `Hit ${targetReps} reps at ${r2(lastWeight)}kg — add ${increment}kg.`,
    };
  },
};
