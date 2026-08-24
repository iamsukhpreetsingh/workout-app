// Shared data-prep for ALL progression formulas.
//
// Sets within one exercise entry may span multiple distinct working weights
// (ramp/pyramid structure, top-set + back-offs, drop sets). ALWAYS group the
// most recent session's sets by weight and evaluate the TOP group only;
// never assume all sets in an exercise share one target weight. Lighter
// groups are ramp-up sets — they are never evaluated against target-hit
// logic and never become the suggestion's basis (the fallback is always to
// repeat the TOP group's own weight, never a lighter group's).

// set_type values eligible for progression — same convention as volume/1RM
// calculations (warmup excluded).
const PROGRESSION_TYPES = new Set(['working', 'dropset', 'failure']);

// Returns the TOP weight group of sessionIndex 0 as an array of set objects
// ([] when there is no usable latest-session data). Warmups are excluded
// even if a caller forgets to filter them; grouping works correctly even
// when EVERY set is tagged 'working' (ramping structure).
export function topWeightGroup(history) {
  const last = (history || []).filter((s) => (s.sessionIndex ?? 0) === 0);
  const eligible = last.filter((s) => PROGRESSION_TYPES.has(s.setType || 'working'));
  if (!eligible.length) return [];
  const groups = new Map();
  for (const s of eligible) {
    const w = Number(s.weight) || 0;
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(s);
  }
  return groups.get(Math.max(...groups.keys()));
}
