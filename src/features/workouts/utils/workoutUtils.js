/**
 * Workout duration/grouping helpers.
 *
 * Moved out of store/WorkoutContext so non-React modules (and screens that
 * shouldn't reach into the store) can use them. WorkoutContext re-exports
 * these for backwards compatibility.
 */

/**
 * Elapsed active-logging seconds, excluding paused intervals.
 * @param {{startTime:number, pausedAt?:number|null, pausedMs?:number}|null} workout
 * @param {number} [now]
 * @returns {number}
 */
export function elapsedSeconds(workout, now = Date.now()) {
  if (!workout) return 0;
  const end = workout.pausedAt ?? now;
  return Math.max(0, Math.floor((end - workout.startTime - (workout.pausedMs || 0)) / 1000));
}

/**
 * Format seconds as H:MM:SS (if >1h) or MM:SS.
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Assign labels A, B, C… to superset group ids by first appearance in the list.
 * @param {Array<{groupId?: string|null}>} exercises
 * @returns {Record<string, string>}
 */
export function groupLabels(exercises) {
  const labels = {};
  let n = 0;
  for (const e of exercises) {
    if (e.groupId && !(e.groupId in labels)) {
      labels[e.groupId] = String.fromCharCode(65 + n++);
    }
  }
  return labels;
}
