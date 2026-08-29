// nutritionTargetsService.js — the ONE authoritative nutrition-target
// service (spec §12/§13). Everything downstream (diet plans, food diary,
// trainer monitoring, history) consumes the result of these functions;
// no screen or service may re-derive targets from the profile itself.
//
// Separation of responsibilities:
//   USER PROFILE            client_intake_profiles (what the client told us)
//   AUTOMATIC RECOMMENDATION nutritionTargetsCalc.calculateRecommendation
//   TRAINER OVERRIDE        a user_nutrition_targets row with source
//                           'trainer_override' (profile stays untouched)
//   ACTIVE TARGET           latest user_nutrition_targets version with
//                           effective_from <= date — what the whole diet
//                           system actually uses
//
// Versioning rules (§10/§11/§18):
//  - target changes NEVER update rows in place — a new version is opened
//    with effective_from = today
//  - saving a profile opens a new AUTOMATIC version only when the
//    recommendation inputs actually changed AND the latest version is not
//    a trainer override (the trainer stays in control; the new
//    recommendation is simply recomputed for review)
const { query } = require('../db/pool');
const intakeProfiles = require('./intakeProfiles');
const calc = require('./nutritionTargetsCalc');
const { assertActiveAssociation } = require('./assignedPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// The recommendation computed from the client's CURRENT profile. Returns
// { ok, missing, errors, recommendation } — ok:false when the profile is
// incomplete (never fabricate a confident number, §17).
async function getRecommendation(userId) {
  const profile = await intakeProfiles.getProfileForClient(userId);
  const result = calc.calculateRecommendation(profile || {});
  return {
    profile_complete: result.ok,
    missing: result.missing,
    errors: result.errors,
    recommendation: result.recommendation,
    profile: profile || null,
  };
}

// Latest version row (by version_number) regardless of date.
async function getLatestVersion(userId) {
  const { rows } = await query(
    `SELECT * FROM user_nutrition_targets WHERE user_id = $1
     ORDER BY version_number DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// The ACTIVE target for a date: latest version with effective_from <= date.
async function getVersionForDate(userId, dateStr = todayStr()) {
  const { rows } = await query(
    `SELECT * FROM user_nutrition_targets
     WHERE user_id = $1 AND effective_from <= $2::date
     ORDER BY effective_from DESC, version_number DESC LIMIT 1`,
    [userId, String(dateStr).slice(0, 10)]
  );
  return rows[0] || null;
}

async function insertVersion(userId, { calories, protein_g, carbs_g, fat_g }, { source, note = null, recommendedSnapshot = null, createdBy = null }) {
  if (!calories || calories <= 0 || protein_g == null || carbs_g == null || fat_g == null) {
    throw new HttpError(400, 'A complete target set is required');
  }
  if (calories < 1000 || calories > 6000) throw new HttpError(400, 'Calories must be between 1000 and 6000');
  for (const m of [protein_g, carbs_g, fat_g]) {
    if (Number(m) < 0 || Number(m) > 1000) throw new HttpError(400, 'Macro targets must be between 0 and 1000 g');
  }
  const latest = await getLatestVersion(userId);
  const { rows } = await query(
    `INSERT INTO user_nutrition_targets
       (user_id, version_number, effective_from, calories, protein_g, carbs_g, fat_g,
        target_source, override_note, recommended_snapshot, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [userId, (latest?.version_number || 0) + 1, todayStr(),
     Math.round(Number(calories)), Number(protein_g), Number(carbs_g), Number(fat_g),
     source, note, recommendedSnapshot ? JSON.stringify(recommendedSnapshot) : null, createdBy]
  );
  return rows[0];
}

const sameNumbers = (a, b) =>
  a && b &&
  Number(a.calories) === Number(b.calories) &&
  Number(a.protein_g) === Number(b.protein_g) &&
  Number(a.carbs_g) === Number(b.carbs_g) &&
  Number(a.fat_g) === Number(b.fat_g);

// Called after every profile save. Opens a new AUTOMATIC version when:
//   - the profile now supports a recommendation, AND
//   - the recommendation actually changed, AND
//   - the latest version is NOT a trainer override (§18 — the trainer's
//     custom targets are never silently overwritten; the updated
//     recommendation is simply available for review).
async function syncAutomaticTargetAfterProfileSave(userId) {
  const { recommendation } = await getRecommendation(userId);
  if (!recommendation) return null; // incomplete profile — nothing to sync
  const latest = await getLatestVersion(userId);
  if (latest && latest.target_source === 'trainer_override') return null;
  if (latest && sameNumbers(latest, recommendation)) return null; // no change, no new version
  return insertVersion(userId, recommendation, { source: 'automatic' });
}

// What the app + diet system should use. active === null means no version
// exists yet (the client should complete their profile / create a plan).
async function getActiveNutritionTargets(userId, dateStr = todayStr()) {
  const [active, rec, profile] = await Promise.all([
    getVersionForDate(userId, dateStr),
    getRecommendation(userId),
    intakeProfiles.getProfileForClient(userId),
  ]);
  let recommendationDrift = false;
  if (active && active.target_source === 'trainer_override' && rec.recommendation) {
    recommendationDrift = !sameNumbers(active, rec.recommendation);
  }
  return {
    active: active
      ? {
          calories: active.calories,
          protein_g: Number(active.protein_g),
          carbs_g: Number(active.carbs_g),
          fat_g: Number(active.fat_g),
          target_source: active.target_source,
          override_note: active.override_note,
          recommended_snapshot: active.recommended_snapshot,
          effective_from: active.effective_from,
          version_number: active.version_number,
        }
      : null,
    recommendation: rec.recommendation,
    profile_complete: rec.profile_complete,
    missing: rec.missing,
    recommendation_drift: recommendationDrift,
    profile: profile || null,
  };
}

// TRAINER OVERRIDE (§6/§8): the trainer sets calories/macros manually.
// The profile is untouched; the recommendation is retained for reference.
async function setTrainerOverride(trainerId, clientId, { calories, protein_g, carbs_g, fat_g, note }) {
  await assertActiveAssociation(trainerId, clientId);
  const rec = await getRecommendation(clientId);
  const version = await insertVersion(
    clientId,
    { calories, protein_g, carbs_g, fat_g },
    {
      source: 'trainer_override',
      note: note ? String(note).trim() || null : null,
      recommendedSnapshot: rec.recommendation,
      createdBy: trainerId,
    }
  );
  return version;
}

// Trainer returns the client to the automatic recommendation (§21).
async function useTrainerRecommendation(trainerId, clientId) {
  await assertActiveAssociation(trainerId, clientId);
  const rec = await getRecommendation(clientId);
  if (!rec.recommendation) {
    throw new HttpError(400, 'The client profile is incomplete — no recommendation available');
  }
  return insertVersion(clientId, rec.recommendation, {
    source: 'automatic',
    createdBy: trainerId,
  });
}

module.exports = {
  getRecommendation,
  getActiveNutritionTargets,
  getVersionForDate,
  syncAutomaticTargetAfterProfileSave,
  setTrainerOverride,
  useTrainerRecommendation,
};
