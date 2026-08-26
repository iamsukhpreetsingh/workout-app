/**
 * Pure helpers/constants for the structured diet plan builder.
 */

/** Meal slot types offered by the builder */
export const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Pre-Workout', 'Post-Workout'];

let uid = 0;

/** Generate a unique key for plan nodes (days/meals/items) */
export const nid = () => `x${Date.now()}_${++uid}`;

/** Round a macro value scaled by a quantity multiplier */
export const scaled = (v, mult) => (v == null ? null : Math.round(Number(v) * mult));

/**
 * Compact macro summary for a meal item, e.g. "480 cal · 32P · 51C · 12F".
 * @param {{calories?: number|null, protein_g?: number|null, carbs_g?: number|null, fat_g?: number|null, quantity_multiplier?: number}} it
 * @returns {string}
 */
export const macroLine = (it) => {
  const m = it.quantity_multiplier || 1;
  const parts = [];
  if (it.calories != null) parts.push(`${scaled(it.calories, m)} cal`);
  if (it.protein_g != null) parts.push(`${scaled(it.protein_g, m)}P`);
  if (it.carbs_g != null) parts.push(`${scaled(it.carbs_g, m)}C`);
  if (it.fat_g != null) parts.push(`${scaled(it.fat_g, m)}F`);
  return parts.join(' · ') || 'macros not set';
};
