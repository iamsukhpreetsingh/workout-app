// Data access for client intake profiles — now the full NUTRITION &
// DIETARY PROFILE (health context + the inputs the automatic target
// calculation uses). ONE profile per client, shared across all their
// trainers: allergens drive the trainer-side conflict warnings; goals /
// injuries / medical_conditions are display-only builder context; the
// body / activity / goal fields feed the nutrition-target calculation.
// A missing profile (null) means the app skips ALL allergen checking —
// never an error. Never include this data in notification bodies or logs.
const { query } = require('../db/pool');
const calc = require('./nutritionTargetsCalc');

// Fetch the client's profile row, or null when none exists. Used by both
// the client (own profile) and trainer (read-only) routes — access control
// lives in the routes (requireRole + association checks).
async function getProfileForClient(clientId) {
  const { rows } = await query(
    'SELECT * FROM client_intake_profiles WHERE client_user_id = $1',
    [clientId]
  );
  return rows[0] || null;
}

// Create or replace the client's own profile. Used by BOTH the onboarding
// gate and later settings edits (same form component, same endpoint).
// completed_at is stamped on every successful save — that timestamp is
// what switches on the trainer-side allergen warnings.
//
// Nutrition fields are OPTIONAL (partial saves stay valid); whatever is
// provided is validated. After a successful save the automatic nutrition
// target is synced (§18): a new automatic version opens only when
// recommendation inputs changed and no trainer override is in force —
// the target service owns that decision. A target-sync failure never
// fails the profile save.
async function upsertProfile(clientId, p = {}) {
  const {
    allergens, goals, injuries, medical_conditions,
    food_preferences, foods_avoided,
  } = p;

  const profilePatch = {
    age: p.age ?? null,
    gender: p.gender ?? null,
    height_cm: p.height_cm ?? null,
    weight_kg: p.weight_kg ?? null,
    target_weight_kg: p.target_weight_kg ?? null,
    activity_level: p.activity_level ?? null,
    primary_goal: p.primary_goal ?? null,
    goal_intensity: p.goal_intensity ?? null,
  };
  const provided = Object.fromEntries(
    Object.entries(profilePatch).filter(([, v]) => v != null && v !== '')
  );
  const strict = calc.validateProvidedNutritionFields(provided);
  if (!strict.ok) {
    const err = new Error(strict.errors.join(', '));
    err.status = 400;
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO client_intake_profiles
       (client_user_id, allergens, goals, injuries, medical_conditions,
        age, gender, height_cm, weight_kg, target_weight_kg,
        activity_level, primary_goal, goal_intensity,
        dietary_pattern, food_preferences, foods_avoided, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (client_user_id) DO UPDATE SET
       allergens = EXCLUDED.allergens,
       goals = EXCLUDED.goals,
       injuries = EXCLUDED.injuries,
       medical_conditions = EXCLUDED.medical_conditions,
       age = EXCLUDED.age,
       gender = EXCLUDED.gender,
       height_cm = EXCLUDED.height_cm,
       weight_kg = EXCLUDED.weight_kg,
       target_weight_kg = EXCLUDED.target_weight_kg,
       activity_level = EXCLUDED.activity_level,
       primary_goal = EXCLUDED.primary_goal,
       goal_intensity = EXCLUDED.goal_intensity,
       dietary_pattern = EXCLUDED.dietary_pattern,
       food_preferences = EXCLUDED.food_preferences,
       foods_avoided = EXCLUDED.foods_avoided,
       completed_at = now(),
       updated_at = now()
     RETURNING *`,
    [clientId, allergens ?? [], goals ?? [], injuries || null, medical_conditions || null,
     profilePatch.age, profilePatch.gender,
     profilePatch.height_cm != null ? Number(profilePatch.height_cm) : null,
     profilePatch.weight_kg != null ? Number(profilePatch.weight_kg) : null,
     profilePatch.target_weight_kg != null ? Number(profilePatch.target_weight_kg) : null,
     profilePatch.activity_level, profilePatch.primary_goal, profilePatch.goal_intensity,
     p.dietary_pattern || null,
     Array.isArray(food_preferences) ? food_preferences : [],
     Array.isArray(foods_avoided) ? foods_avoided : []]
  );

  try {
    // lazy require: this module and the target service reference each
    // other, and a top-level cycle would hand the service an empty exports
    // object (module.exports is replaced below)
    const nutritionTargetsService = require('./nutritionTargetsService');
    await nutritionTargetsService.syncAutomaticTargetAfterProfileSave(clientId);
  } catch {
    // non-fatal: the recommendation is recomputable at any time
  }

  return rows[0];
}

module.exports = { getProfileForClient, upsertProfile };
