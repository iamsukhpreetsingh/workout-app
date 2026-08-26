/**
 * Pure math/constants for the active-workout screen.
 * Extracted verbatim from WorkoutScreen so UI components stay presentational.
 */

// RPE chips offered on completed sets
export const RPE_OPTIONS = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

// Short labels for set-type chips
export const TYPE_META = {
  working: { label: 'W', full: 'Working' },
  warmup: { label: 'WU', full: 'Warm-up' },
  dropset: { label: 'DS', full: 'Drop set' },
  failure: { label: 'F', full: 'Failure' },
};

/**
 * Format seconds as H:MM:SS (if >1h) or MM:SS for the live timer.
 * @param {number} sec
 * @returns {string}
 */
export function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Count of sets marked done across all exercises.
 * @param {Array<{sets: Array<{completed: boolean}>}>} exercises
 * @returns {number}
 */
export function computeDoneSets(exercises) {
  // Volume counts only sets the user marked done (and never warm-ups)
  return exercises.reduce((n, e) => n + e.sets.filter((s) => s.completed).length, 0);
}

/**
 * Total volume (weight × reps) over completed non-warmup sets.
 * @param {Array<{sets: Array<{completed: boolean, type?: string, weight: string, reps: string}>}>} exercises
 * @returns {number}
 */
export function computeTotalVolume(exercises) {
  return exercises.reduce(
    (n, e) =>
      n +
      e.sets
        .filter((s) => s.completed && s.type !== 'warmup')
        .reduce((m, s) => m + (parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0), 0),
    0
  );
}

/**
 * True when a set row has any typed value (used to gate completion).
 * @param {{weight: string, reps: string}} set
 * @returns {boolean}
 */
export function setHasValues(set) {
  return parseFloat(set.weight) > 0 || parseInt(set.reps, 10) > 0;
}
