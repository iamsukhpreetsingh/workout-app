/**
 * Workout/session data service.
 *
 * Single access point for session + PR persistence. UI code must import
 * from here, never from `../db/*` directly, so the storage backend can be
 * swapped without touching screens. Currently a thin facade over the local
 * SQLite modules; async errors propagate to callers (hooks surface them as
 * `{ error }` state).
 */
export {
  listSessions,
  getSession,
  saveSession,
  updateSessionName,
  deleteSession,
  updateSetType,
  getProgressOverview,
  getExerciseProgressList,
  getExerciseProgress,
  getPersonalRecords,
  getExerciseHistory,
  getRecentSets,
} from '../db/queries';
export {
  getPRSetIdsForSession,
  getPRSetIdsForExercise,
  evaluatePR,
} from '../db/pr';
