// foodScaling.js — client-side mirror of the server's unit-aware macro
// scaling (backend/src/data/nutritionLog.js scaleFoodMacros). Global-food
// rows are per 100 g/ml (or per single piece/spoon unit); the dish builder
// snapshots the scaled result at add time.
const PER_PIECE_UNITS = new Set(['piece', 'slice', 'clove', 'scoop', 'bar', 'cup', 'tbsp', 'tsp', 'serving']);

export function scaleFoodMacros(food, quantity = 1, unit) {
  const perPiece = PER_PIECE_UNITS.has(String(unit || food?.default_serving_unit || 'serving').toLowerCase());
  const factor = perPiece ? Number(quantity) || 0 : (Number(quantity) || 0) / 100;
  const scale = (v) => (v == null ? null : Math.round(Number(v) * factor * 10) / 10);
  return {
    calories: food?.calories != null ? Math.round(Number(food.calories) * factor) : null,
    protein_g: scale(food?.protein_g),
    carbs_g: scale(food?.carbs_g),
    fat_g: scale(food?.fat_g),
    fiber_g: scale(food?.fiber_g),
    sugar_g: scale(food?.sugar_g),
    sodium_mg: scale(food?.sodium_mg),
  };
}
