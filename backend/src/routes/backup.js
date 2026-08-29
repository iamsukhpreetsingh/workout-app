// Routes for the full-fidelity backup system (System 3) + user_recipes
// (the real feature table). All endpoints require auth; user identity
// ALWAYS comes from the token — client-supplied user ids are never trusted.
//
// Route conventions:
//  - POST /user/backup/<entity>  → upsert (batch for flat types, nested
//    payload for plan types; children replaced in a transaction)
//  - DELETE /user/backup/<entity>/:localEntityId → queued-delete target,
//    IDEMPOTENT by convention (never 404-loops)
//  - GET /user/backup/<entity>   → everything the caller owns, for restore
//    (?since= for incremental fetches)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const backup = require('../data/backup');
const storage = require('../data/storageService');
const { requireAuth } = require('../middleware/auth');

function httpError(res, e, fallback = 500) {
  const status = e.status || fallback;
  res.status(status).json({ error: e.message || 'Unexpected error' });
}

// ── Restore pre-check: cheap counts, no payloads ────────────────────────
router.get('/backup/summary', requireAuth, async (req, res) => {
  try {
    res.json(await backup.backupSummary(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Custom exercises ────────────────────────────────────────────────────
router.post('/backup/custom-exercises', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertCustomExercises(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/custom-exercises/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteCustomExercise(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/custom-exercises', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listCustomExercises(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Workout plans (existing client_workout_plans wrapper) ───────────────
router.post('/backup/workout-plans', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    res.status(201).json(await backup.templates.upsertTemplates(req.user.id, list));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/workout-plans/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteWorkoutPlan(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/workout-plans', requireAuth, async (req, res) => {
  try {
    res.json(await backup.templates.listForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Sessions (full fidelity) ────────────────────────────────────────────
router.post('/backup/sessions', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    const rows = [];
    for (const p of list) rows.push(await backup.upsertSession(req.user.id, p));
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/sessions/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteSession(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/sessions', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listSessions(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Recipes (real feature table) ────────────────────────────────────────
router.post('/backup/recipes', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    res.status(201).json(await backup.upsertRecipes(req.user.id, list));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/recipes/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteRecipeByLocalId(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/recipes', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listRecipes(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Diet plans (nested) ─────────────────────────────────────────────────
router.post('/backup/diet-plans', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertDietPlan(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/diet-plans/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteDietPlan(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/diet-plans', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listDietPlans(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

// check-ins ride with their plan but are also independently batchable
router.post('/backup/diet-checkins', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertDietCheckins(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/diet-checkins', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listDietCheckins(req.user.id, req.query.plan_local_id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Diet item swaps (date-scoped substitutions) ─────────────────────────
// Private backup for ALL swaps (self-authored AND trainer-assigned plans).
// Trainer-facing visibility is a separate route that filters on
// plan_server_id — nothing here ever exposes another user's data.
router.post('/backup/diet-swaps', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertDietSwaps(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/diet-swaps', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listDietSwaps(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

router.delete('/backup/diet-swaps/:itemRef/:date', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteDietSwap(req.user.id, req.params.itemRef, req.params.date));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Food diary (outcome-first nutrition tracking) ───────────────────────
// The raw food log is the SOURCE OF TRUTH for daily nutrition; no
// precomputed adherence is ever stored. Upserts keyed (user_id,
// local_entity_id) → an offline entry synced repeatedly can never duplicate.
// plan_server_id is set by the client ONLY for trainer-assigned plans and
// drives trainer monitoring visibility (see foodLog.js).
const foodLog = require('../data/foodLog');
// Log-first nutrition layer (migration 040) — search, dishes, user-scoped diary
const nutritionLog = require('../data/nutritionLog');

router.post('/backup/food-log', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await foodLog.upsertFoodLogEntries(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/food-log', requireAuth, async (req, res) => {
  try {
    res.json(await foodLog.listFoodLogEntries(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

router.delete('/backup/food-log/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await foodLog.deleteFoodLogEntry(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Log-first food diary (migration 040) — user-scoped, offline-first ──
// Entries are scoped to the logging user + date, never to a plan. Upserts
// keyed (user_id, local_entity_id) → idempotent under repeated offline syncs.
router.post('/backup/food-log-entries', requireAuth, async (req, res) => {
  try {
    const rows = await nutritionLog.upsertFoodLogEntries(req.user.id, req.body);
    // fire-and-forget missed-target evaluation for every COMPLETED day this
    // sync touched — idempotent per (trainer, client, date, direction), and
    // gated on the trainer's per-client preference, so a day logged in
    // several updates throughout the day can never spam notifications
    const dates = [...new Set(rows.map((r) => String(r.log_date).slice(0, 10)))];
    if (dates.length) {
      const { evaluateMissedTargetNotifications } = require('../data/nutritionDigest');
      evaluateMissedTargetNotifications(req.user.id, dates).catch(() => {});
    }
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/food-log-entries', requireAuth, async (req, res) => {
  try {
    res.json(await nutritionLog.listFoodLogEntries(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

router.delete('/backup/food-log-entries/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await nutritionLog.deleteFoodLogEntry(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Custom dishes (ingredient-based dish builder, snapshot macros) ──────
router.post('/backup/custom-dishes', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    const rows = [];
    for (const p of list) rows.push(await nutritionLog.upsertCustomDish(req.user.id, p));
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/custom-dishes', requireAuth, async (req, res) => {
  try {
    res.json(await nutritionLog.listCustomDishes(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

router.delete('/backup/custom-dishes/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await nutritionLog.deleteCustomDish(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Supplement plans (nested) ───────────────────────────────────────────
router.post('/backup/supplement-plans', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertSupplementPlan(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/supplement-plans/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteSupplementPlan(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/supplement-plans', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listSupplementPlans(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

router.post('/backup/supplement-checkins', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertSupplementCheckins(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.get('/backup/supplement-checkins', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listSupplementCheckins(req.user.id, req.query.plan_local_id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Measurements (existing measurement_entries wrapper) ─────────────────
router.post('/backup/measurements', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.measurementsData.upsertMeasurements(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/measurements/:date/:metricType', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deleteMeasurement(req.user.id, req.params.date, req.params.metricType));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/measurements', requireAuth, async (req, res) => {
  try {
    res.json(await backup.measurementsData.listMeasurements(req.user.id, {}));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Personal records ────────────────────────────────────────────────────
router.post('/backup/personal-records', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await backup.upsertPersonalRecords(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/backup/personal-records/:localId', requireAuth, async (req, res) => {
  try {
    res.json(await backup.deletePersonalRecord(req.user.id, req.params.localId));
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/personal-records', requireAuth, async (req, res) => {
  try {
    res.json(await backup.listPersonalRecords(req.user.id, req.query.since));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Progress photos ─────────────────────────────────────────────────────
// Base64-in-JSON upload (matches the existing dish-photo pattern; no new
// dependencies, works within the 12MB body limit). The image is always
// required — every photo row must point at a real file, never a phantom.
router.post('/backup/progress-photos', requireAuth, async (req, res) => {
  try {
    const { local_entity_id, date, angle, image_base64 } = req.body || {};
    if (!local_entity_id || !date || !image_base64) {
      return res.status(400).json({ error: 'local_entity_id, date and image_base64 are required' });
    }
    const dataUri = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(image_base64);
    const rawB64 = dataUri ? dataUri[2] : String(image_base64).replace(/\s+/g, '');
    if (!rawB64) {
      return res.status(400).json({ error: 'image_base64 is not valid base64 image data' });
    }
    const raw = Buffer.from(rawB64, 'base64');
    if (!raw.length || raw.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'image too large (max 8MB)' });
    }
    const ext = dataUri ? (dataUri[1] === 'jpeg' ? 'jpg' : dataUri[1]) : 'jpg';
    const storageKey = `${req.user.id}/${crypto.randomUUID()}.${ext}`;
    await storage.upload(raw, storageKey);
    const row = await backup.upsertProgressPhoto(req.user.id, {
      local_entity_id,
      date,
      angle,
      storage_key: storageKey,
    });
    res.status(201).json({ ...row, url: storage.getUrl(req, row.storage_key) });
  } catch (e) {
    httpError(res, e);
  }
});

router.get('/backup/progress-photos', requireAuth, async (req, res) => {
  try {
    const rows = await backup.listProgressPhotos(req.user.id);
    res.json(rows.map((r) => ({ ...r, url: storage.getUrl(req, r.storage_key) })));
  } catch (e) {
    httpError(res, e);
  }
});

router.delete('/backup/progress-photos/:localId', requireAuth, async (req, res) => {
  try {
    const result = await backup.deleteProgressPhoto(req.user.id, req.params.localId);
    if (result.storage_key) await storage.remove(result.storage_key);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e);
  }
});

module.exports = router;