// RPE-Autoregulated — adjusts weight by how hard the last session felt.
// Graceful fallback: if no RPE was logged for the last session's sets, this
// formula delegates to Linear Progression's logic for that suggestion
// instead of erroring or returning nothing.
import linear from './linearProgression.js';
import { topWeightGroup } from './weightGroups.js';


const r2 = (v) => Math.round(v * 100) / 100;

export default {
  key: 'rpe_autoregulated',
  displayName: 'RPE-Autoregulated',
  description: 'Adjusts weight by how hard the last session felt (average RPE). Falls back to Linear Progression when RPE was not logged.',
  paramSchema: [
    { key: 'easyThreshold', label: 'Below this RPE: add weight', type: 'number', default: 7.5, min: 5, max: 10 },
    { key: 'hardThreshold', label: 'At/above this RPE: reduce weight', type: 'number', default: 9, min: 5, max: 10 },
    { key: 'incrementKg', label: 'Weight increase (kg)', type: 'number', default: 2.5, min: 0.5, max: 20 },
    { key: 'decrementKg', label: 'Weight decrease (kg)', type: 'number', default: 2.5, min: 0.5, max: 20 },
  ],
  calculate(recentHistory, params) {
    if (!Array.isArray(recentHistory) || !recentHistory.length) return null;
    // RPE is judged on the TOP weight group only — ramp sets at lighter
    // weights don't reflect how the working weight felt.
    const group = topWeightGroup(recentHistory);
    const withRpe = group.filter((s) => s.rpe != null);
    if (!withRpe.length) {
      // no RPE data → Linear Progression's logic, not an error
      return linear.calculate(recentHistory, {
        incrementKg: params?.incrementKg ?? 2.5,
        requireAllSetsHit: true,
      });
    }

    const avg = withRpe.reduce((n, s) => n + Number(s.rpe), 0) / withRpe.length;
    const lastWeight = Number(group[0].weight) || 0;
    const targetReps = Math.max(...group.map((s) => s.reps ?? 0));
    const easy = Number(params?.easyThreshold ?? 7.5);
    const hard = Number(params?.hardThreshold ?? 9);

    if (avg < easy) {
      return {
        suggestedWeight: r2(lastWeight + Number(params?.incrementKg ?? 2.5)),
        suggestedReps: targetReps,
        rationale: `Avg RPE ${r2(avg)} felt easy (under ${easy}) — add weight.`,
      };
    }
    if (avg >= hard) {
      return {
        suggestedWeight: r2(Math.max(0, lastWeight - Number(params?.decrementKg ?? 2.5))),
        suggestedReps: targetReps,
        rationale: `Avg RPE ${r2(avg)} was very hard (≥ ${hard}) — back off a little.`,
      };
    }
    return {
      suggestedWeight: r2(lastWeight),
      suggestedReps: targetReps,
      rationale: `Avg RPE ${r2(avg)} is in the sweet spot — hold this weight.`,
    };
  },
};