// /**
//  * Routine (workout plan) data service.
//  *
//  * Single access point for plan CRUD. UI code must import from here, never
//  * from `../db/*` directly. Thin facade over the local SQLite module.
//  */
// export {
//   listPlans,
//   getPlan,
//   createPlan,
//   updatePlan,
//   deletePlan,
// } from '../db/queries';



/**
 * Routine (workout plan) data service.
 *
 * Single access point for plan CRUD + historical-session logging. UI code
 * must import from here, never from `../db/*` directly.
 */
export {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
} from '../db/queries';

import { saveSession } from '../db/queries';

// Historical workout logging: save a past session with the CHOSEN date as
// its start_time. Everything downstream keys off that timestamp — History
// ordering, sync's performed_at, PR achieved_at, streak calculation — so a
// backfilled workout is indistinguishable from one logged live, except no
// live timer/rest state was involved. PRs ARE recorded (real history).
// duration_sec is null: actual duration is unknown and never fabricated.
export async function saveBackfilledSession({ name, startTime, notes, planId, exercises }) {
  return saveSession({
    name,
    start_time: startTime,
    end_time: null,
    duration_sec: null,
    notes,
    plan_id: planId,
    exercises: exercises.map((ex, i) => ({
      exerciseId: ex.exerciseId,
      restSeconds: ex.restSeconds,
      groupId: ex.groupId,
      notes: null,
      sets: ex.sets,
    })),
  });
}