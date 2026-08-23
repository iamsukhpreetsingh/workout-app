// Double Progression — same weight while climbing reps within a range; when
// every completed set hits the top of the range, add weight and reset reps
// to the bottom.
const r2 = (v) => Math.round(v * 100) / 100;

export default {
  key: 'double_progression',
  displayName: 'Double Progression',
  description: 'Same weight, add reps within a range (e.g. 8–12); when all sets hit the top, add weight and reset reps.',
  paramSchema: [
    { key: 'repMin', label: 'Bottom of rep range', type: 'number', default: 8, min: 1, max: 20 },
    { key: 'repMax', label: 'Top of rep range', type: 'number', default: 12, min: 1, max: 30 },
    { key: 'incrementKg', label: 'Weight increase (kg)', type: 'number', default: 2.5, min: 0.5, max: 20 },
  ],
  calculate(recentHistory, params) {
    if (!Array.isArray(recentHistory) || !recentHistory.length) return null;
    const repMin = Number(params?.repMin ?? 8);
    const repMax = Number(params?.repMax ?? 12);
    const increment = Number(params?.incrementKg ?? 2.5);

    const last = recentHistory.filter((s) => (s.sessionIndex ?? 0) === 0 && s.completed);
    if (!last.length) return null;

    const lastWeight = Number(last[0].weight) || 0;
    const allAtTop = last.every((s) => (s.reps ?? 0) >= repMax);

    if (allAtTop) {
      return {
        suggestedWeight: r2(lastWeight + increment),
        suggestedReps: repMin,
        rationale: `All sets hit ${repMax} reps at ${r2(lastWeight)}kg — add ${increment}kg and drop back to ${repMin} reps.`,
      };
    }
    const weakest = Math.min(...last.map((s) => s.reps ?? 0));
    const nextReps = Math.min(weakest + 1, repMax);
    return {
      suggestedWeight: r2(lastWeight),
      suggestedReps: nextReps,
      rationale: `Stay at ${r2(lastWeight)}kg and push reps — aim for ${nextReps} (range ${repMin}–${repMax}).`,
    };
  },
};