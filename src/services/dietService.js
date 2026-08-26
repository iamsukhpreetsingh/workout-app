/**
 * Diet plan data service.
 *
 * Single access point for diet-plan and recipe persistence. UI code must
 * import from here, never from `../db/*` directly. Thin facade over local
 * SQLite + legacy server API modules.
 */
export {
  listRecipes,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  getRecipe,
} from '../db/recipes';
export {
  createDietPlan,
  updateDietPlan,
  getDietPlan,
  isLocalDietPlanId,
  listLocalDietPlans,
} from '../db/dietPlans';
export {
  listLocalSupplementPlans,
} from '../db/supplementPlans';
