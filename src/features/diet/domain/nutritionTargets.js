// nutritionTargets.js — THE authoritative nutrition-target calculator
// (spec: "one centralized calculation, never duplicated across screens").
//
// Pure functions, no RN/fetch imports — runs under plain Node so
// test/runTests.js can regression-test it. A behaviorally identical
// CommonJS mirror lives at backend/src/data/nutritionTargetsCalc.js; both
// are covered by test suites asserting the same scenarios.
//
// Pipeline: profile → BMR (Mifflin-St Jeor) → activity factor →
// goal/intensity adjustment → daily calorie target → macro distribution.
//
// The UI shows ONLY the final numbers — formulas stay internal (§3).

export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: 'Sedentary', factor: 1.2 },
  { key: 'light', label: 'Lightly active', factor: 1.375 },
  { key: 'moderate', label: 'Moderately active', factor: 1.55 },
  { key: 'very', label: 'Very active', factor: 1.725 },
  { key: 'extreme', label: 'Extremely active', factor: 1.9 },
];

export const PRIMARY_GOALS = [
  { key: 'weight_loss', label: 'Lose Weight' },
  { key: 'weight_maintenance', label: 'Maintain Weight' },
  { key: 'muscle_gain', label: 'Gain Muscle' },
  { key: 'recomposition', label: 'Recomposition' },
  { key: 'general_fitness', label: 'General Fitness' },
];

// Desired rate of change — only meaningful for weight_loss / muscle_gain.
export const GOAL_INTENSITIES = [
  { key: 'mild', label: 'Gentle' },
  { key: 'standard', label: 'Steady' },
  { key: 'aggressive', label: 'Aggressive' },
];

export const DIETARY_PATTERNS = [
  'No preference', 'Vegetarian', 'Vegan', 'Pescatarian', 'Keto', 'Halal', 'Other',
];

export const GENDERS = [
  { key: 'male', label: 'Male' },
  { key: 'female', label: 'Female' },
  { key: 'other', label: 'Other' },
];

// Calorie adjustment by goal (and intensity where applicable).
const GOAL_CALORIE_ADJUSTMENT = {
  weight_loss: { mild: -0.1, standard: -0.2, aggressive: -0.25 },
  muscle_gain: { mild: 0.05, standard: 0.1, aggressive: 0.15 },
  weight_maintenance: { mild: 0, standard: 0, aggressive: 0 },
  recomposition: { mild: -0.05, standard: -0.05, aggressive: -0.05 },
  general_fitness: { mild: 0, standard: 0, aggressive: 0 },
};

// Protein grams per kg bodyweight by goal.
const PROTEIN_G_PER_KG = {
  weight_loss: 2.0,
  recomposition: 2.0,
  muscle_gain: 1.8,
  weight_maintenance: 1.6,
  general_fitness: 1.6,
};

// Fat share of calories by goal.
const FAT_CALORIE_SHARE = {
  weight_loss: 0.25,
  recomposition: 0.28,
  muscle_gain: 0.3,
  weight_maintenance: 0.3,
  general_fitness: 0.3,
};

// Safety floors — a recommendation never goes below these.
const MIN_CALORIES = { male: 1500, female: 1200, other: 1350 };

const ACTIVITY_KEYS = ACTIVITY_LEVELS.map((a) => a.key);
const GOAL_KEYS = PRIMARY_GOALS.map((g) => g.key);
const INTENSITY_KEYS = GOAL_INTENSITIES.map((g) => g.key);
const GENDER_KEYS = GENDERS.map((g) => g.key);

// Validate one profile patch. Returns { ok, missing, errors } — the backend
// persists only when ok; the UI uses `missing` for the "we need a little
// more information" state (§17). Missing OPTIONAL info is fine; only the
// fields the calculation actually needs are required.
export function validateNutritionProfile(p = {}) {
  const missing = [];
  const errors = [];
  const num = (v) => (v === '' || v == null ? null : Number(v));

  const age = num(p.age);
  if (age == null) missing.push('age');
  else if (!isFinite(age) || age < 13 || age > 90) errors.push('age must be between 13 and 90');

  if (!p.gender) missing.push('gender');
  else if (!GENDER_KEYS.includes(p.gender)) errors.push('unsupported gender value');

  const height = num(p.height_cm);
  if (height == null) missing.push('height_cm');
  else if (!isFinite(height) || height < 100 || height > 250) errors.push('height must be between 100 and 250 cm');

  const weight = num(p.weight_kg);
  if (weight == null) missing.push('weight_kg');
  else if (!isFinite(weight) || weight < 30 || weight > 300) errors.push('weight must be between 30 and 300 kg');

  const targetWeight = num(p.target_weight_kg);
  if (targetWeight != null && (!isFinite(targetWeight) || targetWeight < 30 || targetWeight > 300)) {
    errors.push('target weight must be between 30 and 300 kg');
  }

  if (!p.activity_level) missing.push('activity_level');
  else if (!ACTIVITY_KEYS.includes(p.activity_level)) errors.push('unsupported activity level');

  if (!p.primary_goal) missing.push('primary_goal');
  else if (!GOAL_KEYS.includes(p.primary_goal)) errors.push('unsupported goal');

  if (p.goal_intensity != null && p.goal_intensity !== '' && !INTENSITY_KEYS.includes(p.goal_intensity)) {
    errors.push('unsupported goal intensity');
  }

  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

// Validate ONLY the fields present in the patch — partial saves (e.g. the
// onboarding gate answering just allergens) must pass. Absent fields are
// not "missing"; present-but-invalid values are errors. Used by the
// backend on every profile upsert.
export function validateProvidedNutritionFields(patch = {}) {
  const errors = [];
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const age = num(patch.age);
  if (age != null && (!isFinite(age) || age < 13 || age > 90)) errors.push('age must be between 13 and 90');
  if (patch.gender != null && patch.gender !== '' && !GENDER_KEYS.includes(patch.gender)) errors.push('unsupported gender value');
  const height = num(patch.height_cm);
  if (height != null && (!isFinite(height) || height < 100 || height > 250)) errors.push('height must be between 100 and 250 cm');
  const weight = num(patch.weight_kg);
  if (weight != null && (!isFinite(weight) || weight < 30 || weight > 300)) errors.push('weight must be between 30 and 300 kg');
  const targetWeight = num(patch.target_weight_kg);
  if (targetWeight != null && (!isFinite(targetWeight) || targetWeight < 30 || targetWeight > 300)) {
    errors.push('target weight must be between 30 and 300 kg');
  }
  if (patch.activity_level != null && patch.activity_level !== '' && !ACTIVITY_KEYS.includes(patch.activity_level)) {
    errors.push('unsupported activity level');
  }
  if (patch.primary_goal != null && patch.primary_goal !== '' && !GOAL_KEYS.includes(patch.primary_goal)) {
    errors.push('unsupported goal');
  }
  if (patch.goal_intensity != null && patch.goal_intensity !== '' && !INTENSITY_KEYS.includes(patch.goal_intensity)) {
    errors.push('unsupported goal intensity');
  }
  return { ok: errors.length === 0, errors };
}

// fields that change the recommendation — used to decide whether saving a
// profile should open a new automatic target version
export const RECOMMENDATION_INPUT_FIELDS = [
  'age', 'gender', 'height_cm', 'weight_kg', 'target_weight_kg',
  'activity_level', 'primary_goal', 'goal_intensity',
];

export function recommendationInputsChanged(a = {}, b = {}) {
  return RECOMMENDATION_INPUT_FIELDS.some((k) => {
    const av = a[k] == null ? null : Number.isFinite(Number(a[k])) ? Number(a[k]) : a[k];
    const bv = b[k] == null ? null : Number.isFinite(Number(b[k])) ? Number(b[k]) : b[k];
    return av !== bv;
  });
}

// The recommendation. Returns { ok, missing, errors, recommendation, details }
// — `ok: false` when required inputs are missing (never fabricate a
// confident number from incomplete data, §17).
export function calculateRecommendation(profile = {}) {
  const v = validateNutritionProfile(profile);
  if (!v.ok) {
    return { ok: false, missing: v.missing, errors: v.errors, recommendation: null, details: null };
  }

  const weight = Number(profile.weight_kg);
  const height = Number(profile.height_cm);
  const age = Number(profile.age);
  const gender = GENDER_KEYS.includes(profile.gender) ? profile.gender : 'other';

  // Mifflin-St Jeor
  const bmr = 10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : gender === 'female' ? -161 : -78);
  const activity = ACTIVITY_LEVELS.find((a) => a.key === profile.activity_level) || ACTIVITY_LEVELS[0];
  const tdee = bmr * activity.factor;

  const goal = GOAL_KEYS.includes(profile.primary_goal) ? profile.primary_goal : 'weight_maintenance';
  const intensity = INTENSITY_KEYS.includes(profile.goal_intensity)
    ? profile.goal_intensity
    : goal === 'weight_loss' || goal === 'muscle_gain' ? 'standard' : 'standard';
  const adjustment = GOAL_CALORIE_ADJUSTMENT[goal][intensity] ?? 0;
  let calories = tdee * (1 + adjustment);
  calories = Math.max(calories, MIN_CALORIES[gender]);
  const caloriesRounded = Math.round(calories / 10) * 10;

  // macros — protein by bodyweight, fat by calorie share, carbs the remainder
  const proteinG = Math.round(weight * PROTEIN_G_PER_KG[goal]);
  const fatG = Math.max(Math.round((caloriesRounded * FAT_CALORIE_SHARE[goal]) / 9), Math.round(weight * 0.5));
  const carbsG = Math.max(Math.round((caloriesRounded - proteinG * 4 - fatG * 9) / 4), 0);

  return {
    ok: true,
    missing: [],
    errors: [],
    recommendation: { calories: caloriesRounded, protein_g: proteinG, carbs_g: carbsG, fat_g: fatG },
    // internal reference only — never rendered in the normal user UI (§3)
    details: {
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      goal,
      intensity,
      activity_factor: activity.factor,
    },
  };
}
