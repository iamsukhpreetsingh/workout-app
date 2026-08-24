// Per-set POSITIONAL prefill helpers (pure, unit-testable — no RN imports).
//
// The "last time" placeholder on each set row must show the SAME POSITION's
// set from the most recent prior session — not the last set overall, not a
// blended/best value. If the current session has MORE sets than the prior
// one, positions beyond the prior history get NO prev (no hint), never a
// repeat of the last known set — repeating it would reintroduce the
// collapsed-to-last-set bug this module replaced.

// Normalize raw prior-session rows into position-ordered prev descriptors.
export function positionalPrevs(previousSets) {
  return (previousSets || [])
    .filter((s) => Number(s?.weight) > 0 || Number(s?.reps) > 0 || s?.completed === 1)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => ({
      weight: Number(s.weight) || 0,
      reps: Number(s.reps) || 0,
      rpe: s.rpe ?? null,
    }));
}
