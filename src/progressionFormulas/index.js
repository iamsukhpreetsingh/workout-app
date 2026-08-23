// Formula registry — adding a new formula is exactly THREE steps (documented
// in the README, Phase D):
//   1. Create src/progressionFormulas/yourFormula.js exporting the standard
//      shape: { key, displayName, description, paramSchema, calculate }.
//   2. Add ONE import line below and include it in FORMULAS.
//   3. Add the same metadata (NO calculate) to
//      backend/src/data/progressionFormulas.json — the one manual
//      cross-codebase sync step, so the backend can validate and serve it.
import linear from './linearProgression';
import double from './doubleProgression';
import rpe from './rpeAutoregulated';
import percentage from './percentageBased';

const FORMULAS = [linear, double, rpe, percentage];

export const DEFAULT_FORMULA_KEY = 'linear_progression';

export function listFormulas() {
  return FORMULAS.map(({ calculate, ...meta }) => meta);
}

export function getFormula(key) {
  return FORMULAS.find((f) => f.key === key) || null;
}