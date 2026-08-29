/**
 * Pure helpers/constants for the structured diet plan builder.
 */

/** Meal slot types offered by the builder */
export const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Pre-Workout', 'Post-Workout'];

let uid = 0;

/** Generate a unique key for plan nodes (days/meals/items) */
export const nid = () => `x${Date.now()}_${++uid}`;

/**
 * Macro value scaled by a quantity multiplier. Rounds by default; pass
 * { round: false } where the caller sums many values before rounding
 * (e.g. daily totals) — the two historical variants behaved differently.
 */
export const scaled = (v, mult, opts = {}) => {
  if (v == null) return null;
  const n = Number(v) * (mult || 1);
  return opts.round === false ? n : Math.round(n);
};

/**
 * Compact macro summary for a meal item, e.g. "480 cal · 32P · 51C · 12F".
 * Pass { withServing: true } to append the serving size — the variant the
 * plan detail screen shows.
 * @param {{calories?: number|null, protein_g?: number|null, carbs_g?: number|null, fat_g?: number|null, quantity_multiplier?: number, serving_size?: string|null}} it
 * @returns {string}
 */
export const macroLine = (it, opts = {}) => {
  const m = it.quantity_multiplier || 1;
  const parts = [];
  if (it.calories != null) parts.push(`${scaled(it.calories, m)} cal`);
  if (it.protein_g != null) parts.push(`${scaled(it.protein_g, m)}P`);
  if (it.carbs_g != null) parts.push(`${scaled(it.carbs_g, m)}C`);
  if (it.fat_g != null) parts.push(`${scaled(it.fat_g, m)}F`);
  if (opts.withServing && it.serving_size) parts.push(it.serving_size);
  return parts.join(' · ') || 'macros not set';
};
