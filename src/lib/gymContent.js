// gymContent.js — pure (React-free) helpers for gym-provided member
// content: workouts and nutrition from GET /gym/my/content.
//
// WHY THIS EXISTS: the /gym/my/content API contract says nutrition
// `content` is `{ entries: string[] }` (that is what the gym-web admin
// editor saves and what the backend validator accepts), but gym-authored
// data can carry RICHER structured lines — the demo seed writes
// `{ type: 'ingredient'|'step'|'day'|'guideline', text, day? }` objects
// straight into the JSONB column. Rendering such an entry directly inside
// a React Native <Text> crashes with "Objects are not valid as a React
// child (found: object with keys {text, type})". Every consumer therefore
// normalizes entries through normalizeNutritionEntries() ONCE at the
// render boundary — never JSON.stringify, the structured `type` is
// preserved and drives how the line is presented.

// kind → human label (RECIPE | MEAL_PLAN | DIET_RECOMMENDATION)
export const GYM_NUTRITION_KIND_LABELS = {
  RECIPE: 'Recipe',
  MEAL_PLAN: 'Meal plan',
  DIET_RECOMMENDATION: 'Diet guide',
};

// structured entry type → group heading (null = ungrouped generic line)
export const GYM_ENTRY_TYPE_LABELS = {
  ingredient: 'Ingredients',
  step: 'Preparation',
  day: 'Day plan',
  guideline: 'Guidelines',
  entry: null, // plain string lines from the admin editor
};

const ENTRY_ORDER = ['ingredient', 'step', 'day', 'guideline', 'entry'];

// Normalize one raw content entry to { type, day, text }.
//   'string'            → { type: 'entry',  day: null, text }
//   { text, type, day?} → { type,          day,      text }   (seed format)
//   other primitives    → { type: 'entry',  day: null, String(v) }
//   objects without text→ null (nothing renderable — never '[object Object]')
export function normalizeNutritionEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? { type: 'entry', day: null, text } : null;
  }
  if (typeof raw === 'object') {
    if (typeof raw.text !== 'string') return null;
    const text = raw.text.trim();
    if (!text) return null;
    return {
      type: GYM_ENTRY_TYPE_LABELS[raw.type] ? raw.type : 'entry',
      day: typeof raw.day === 'string' && raw.day.trim() ? raw.day.trim() : null,
      text,
    };
  }
  // numbers etc. — the backend validator would have String()-coerced these
  const text = String(raw).trim();
  return text ? { type: 'entry', day: null, text } : null;
}

// Normalize a nutrition item's `content` into a flat list of
// { type, day, text } lines. Tolerates: null/undefined, { entries: [...] },
// a bare array (defensive), a raw JSON string (defensive against an
// unparsed JSONB row), and mixed string/object entries.
export function normalizeNutritionEntries(content) {
  let raw = content;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  const rawEntries = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.entries)
      ? raw.entries
      : [];
  return rawEntries
    .map(normalizeNutritionEntry)
    .filter(Boolean);
}

// Group normalized entries by their structured type, in a stable display
// order (ingredients → preparation → day plan → guidelines → other lines).
// Returns [{ type, label, items: [{ day, text }] }] — only non-empty groups.
export function groupNutritionEntries(normalized) {
  const groups = new Map();
  for (const e of normalized) {
    if (!groups.has(e.type)) groups.set(e.type, []);
    groups.get(e.type).push({ day: e.day, text: e.text });
  }
  return ENTRY_ORDER
    .filter((t) => groups.has(t))
    .map((t) => ({ type: t, label: GYM_ENTRY_TYPE_LABELS[t], items: groups.get(t) }));
}

// The one-line meta under a workout title in lists.
export function workoutMetaLine(workout) {
  const bits = [];
  if (workout?.difficulty) bits.push(workout.difficulty);
  if (workout?.goal && workout.goal !== 'general') bits.push(workout.goal.replace('_', ' '));
  if (workout?.estimated_duration_minutes) bits.push(`${workout.estimated_duration_minutes} min`);
  const n = Array.isArray(workout?.exercises) ? workout.exercises.length : 0;
  if (n) bits.push(`${n} exercise${n > 1 ? 's' : ''}`);
  return bits.join(' · ');
}

// Map /gym/my/content nutrition items into FoodSearchModal picker rows —
// the same row contract FoodSearchModal already consumes for trainer items
// (per-item macros, no allergen data). One gym entry per item; logging
// flows through the EXISTING logFoodEntry diary writer (foodSourceType
// 'manual'), so no second logging system is created.
export function gymNutritionToPickerItems(perGymRows) {
  const out = [];
  for (const g of Array.isArray(perGymRows) ? perGymRows : []) {
    const items = [
      ...(g?.nutrition?.assigned || []).map((n) => ({ n, tag: 'Assigned' })),
      ...(g?.nutrition?.recommended || []).map((n) => ({ n, tag: 'Recommended' })),
    ];
    for (const { n, tag } of items) {
      if (!n || !n.id || !n.title) continue;
      out.push({
        id: `gym-${n.id}`,
        name: String(n.title),
        calories: n.targets?.calories ?? null,
        protein_g: n.targets?.protein_g ?? null,
        carbs_g: n.targets?.carbs_g ?? null,
        fat_g: n.targets?.fat_g ?? null,
        kind: n.kind,
        kindLabel: GYM_NUTRITION_KIND_LABELS[n.kind] || n.kind || null,
        tag,
        gym_name: g?.gym_name || null,
        // FoodSearchModal picks these up for per-serving quantity scaling
        default_serving_size: 1,
        default_serving_unit: 'serving',
      });
    }
  }
  return out;
}
