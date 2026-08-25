/**
 * Routine (workout plan) data service.
 *
 * Single access point for plan CRUD. UI code must import from here, never
 * from `../db/*` directly. Thin facade over the local SQLite module.
 */
export {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
} from '../db/queries';
