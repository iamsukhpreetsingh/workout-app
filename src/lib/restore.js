// System 5 — restore-on-login. If restore_completed_at is unset for this
// user and the cloud backup summary is non-empty, rehydrate the ENTIRE
// local database from /user/backup/* in strict parent-before-child order.
// Every restored row is written synced=1 + server_id — the sync engine
// must NEVER re-upload restored data. Any step failure throws; the caller
// (RestoreScreen) offers Retry; the flag is only stamped on full success,
// so a mid-restore app kill retries the whole thing (upserts make partial
// re-runs harmless). Flags are per-user JSON maps so multi-account devices
// each get their own restore.
import * as FileSystem from 'expo-file-system';
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { api } from './api';
import { getAccessToken, API_BASE } from './api';
import { startRestoreRunReport, finishRestoreRunReport } from './adminTelemetry';

const PHOTOS_DIR = `${FileSystem.documentDirectory}progress_photos/`;

async function getRestoreFlag(userId) {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT restore_completed_at AS v FROM user_settings WHERE id = 1');
  if (!row?.v) return null;
  try { return (JSON.parse(row.v) || {})[userId] || null; } catch { return null; }
}

async function setRestoreFlag(userId) {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT restore_completed_at AS v FROM user_settings WHERE id = 1');
  let map = {};
  try { map = JSON.parse(row?.v) || {}; } catch {}
  map[userId] = new Date().toISOString();
  await db.runAsync('UPDATE user_settings SET restore_completed_at = ? WHERE id = 1', [JSON.stringify(map)]);
}

export async function isRestoreNeeded() {
  const userId = getCurrentUserId();
  if (!userId) return false;
  if (await getRestoreFlag(userId)) return false;
  const summary = await api('/user/backup/summary');
  const total = Object.values(summary || {}).reduce((n, c) => n + (Number(c) || 0), 0);
  if (total === 0) {
    // genuinely new account (or a device-first user with no cloud data —
    // the backfill handles that direction)
    await setRestoreFlag(userId);
    return false;
  }
  return true;
}

// Public entry point — unchanged behavior, plus fire-and-forget telemetry
// for the admin dashboard's restore monitoring (Phase 11). Reporting can
// never throw and never alters the restore outcome; failures re-throw
// exactly as before.
export async function performRestore(onProgress = () => {}) {
  const runId = await startRestoreRunReport();
  try {
    await runRestoreSteps(onProgress);
    finishRestoreRunReport(runId, 'success');
  } catch (e) {
    finishRestoreRunReport(runId, 'failed', e?.message?.slice(0, 200) || null);
    throw e;
  }
}

async function runRestoreSteps(onProgress = () => {}) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const db = await getDb();
  const TOTAL = 9;
  let stepIndex = 0;
  const step = async (label, fn) => {
    stepIndex++;
    onProgress({ step: label, index: stepIndex, total: TOTAL, detail: null });
    await fn((detail) => onProgress({ step: label, index: stepIndex, total: TOTAL, detail }));
  };

  // exercises resolve by NAME — the portable key across devices. A missing
  // custom exercise gets a stub here; it syncs as its own entity later.
  const exerciseIdByName = async (name, muscleGroup) => {
    const row = await db.getFirstAsync('SELECT id FROM exercises WHERE name = ?', [name]);
    if (row) return row.id;
    const r = await db.runAsync(
      'INSERT INTO exercises (name, muscle_group, is_custom, synced) VALUES (?, ?, 0, 1)',
      [name, muscleGroup || 'other']);
    return r.lastInsertRowId;
  };






    await step('Custom exercises', async () => {
    const rows = await api('/user/backup/custom-exercises');
    for (const e of rows) {
      const existing = await db.getFirstAsync('SELECT id FROM exercises WHERE name = ?', [e.name]);
      if (existing) {
        await db.runAsync(
          `UPDATE exercises SET synced = 1, server_id = ?, is_custom = 1,
             user_id = COALESCE(user_id, ?),
             equipment = COALESCE(?, equipment), body_part = COALESCE(?, body_part)
           WHERE id = ?`,
          [e.id, userId, e.equipment ?? null, e.body_part ?? null, existing.id]);
      } else {
        await db.runAsync(
          `INSERT INTO exercises
             (name, muscle_group, is_custom, instructions, thumbnail_path, synced, server_id, user_id, equipment, body_part)
           VALUES (?,?,1,?,?,1,?,?,?,?)`,
          [e.name, e.muscle_group || 'other', e.instructions ?? null, e.thumbnail_path ?? null,
           e.id, userId, e.equipment ?? null, e.body_part ?? null]);
      }
    }
  });

  

  await step('Workout routines', async () => {
    const rows = await api('/user/backup/workout-plans');
    for (const p of rows) {
      const planId = parseInt(p.local_plan_id, 10);
      if (isNaN(planId)) continue;
      let exercises = p.exercises;
      if (typeof exercises === 'string') {
        try { exercises = JSON.parse(exercises); } catch { exercises = []; }
      }
      await db.runAsync(
        `INSERT OR REPLACE INTO workout_plans (id, name, notes, created_at, user_id, tags, synced, server_id)
         VALUES (?,?,?,?,?,?,1,?)`,
        [planId, p.name || 'Untitled', p.notes ?? null,
         p.created_at ? new Date(p.created_at).getTime() : Date.now(),
         userId, JSON.stringify(p.tags || []), p.id]);
      await db.runAsync('DELETE FROM plan_exercises WHERE plan_id = ?', [planId]);
      await db.runAsync(
        `DELETE FROM plan_exercise_alternatives WHERE plan_exercise_id IN (
           SELECT CAST(id AS TEXT) FROM plan_exercises WHERE plan_id = ?)`, [planId]);
      for (let i = 0; i < (exercises || []).length; i++) {
        const ex = exercises[i] || {};
        let exerciseId = null;
        if (ex.exercise_name) exerciseId = await exerciseIdByName(ex.exercise_name, ex.muscle_group);
        else if (ex.exercise_id != null) {
          const row = await db.getFirstAsync('SELECT id FROM exercises WHERE id = ?', [ex.exercise_id]);
          if (row) exerciseId = row.id;
        }
        if (exerciseId == null) continue;
        const pe = await db.runAsync(
          `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
           VALUES (?,?,?,?,?,?)`,
          [planId, exerciseId, ex.order_index ?? i, ex.target_sets ?? 3, ex.rest_seconds ?? 90, ex.group_id ?? null]);
        // configured swap alternatives — restored so routines keep their
        // substitution options after a device wipe/reinstall
        const alts = Array.isArray(ex.alternatives) ? ex.alternatives : [];
        for (let ai = 0; ai < Math.min(alts.length, 3); ai++) {
          const name = String(typeof alts[ai] === 'string' ? alts[ai] : alts[ai]?.alternative_exercise_name || '').trim();
          if (!name) continue;
          await db.runAsync(
            `INSERT INTO plan_exercise_alternatives (plan_exercise_id, alternative_exercise_name, order_index)
             VALUES (?,?,?)`,
            [String(pe.lastInsertRowId), name, ai]);
        }
      }
    }
  });

  await step('Your recipes', async () => {
    const rows = await api('/user/backup/recipes');
    for (const r of rows) {
      await db.runAsync(
        `INSERT OR REPLACE INTO local_recipes
           (local_id, server_id, user_id, synced, name, description, prep_notes, calories, protein_g,
            carbs_g, fat_g, serving_size, recipe_url, photo_path, ingredients, allergens,
            prep_time_minutes, cook_time_minutes, difficulty, suggested_meal_types, is_favorite,
            alternate_servings, tags, created_at, updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.local_entity_id, r.id, userId, r.name, r.description ?? null, r.prep_notes ?? null,
         r.calories ?? null, r.protein_g ?? null, r.carbs_g ?? null, r.fat_g ?? null,
         r.serving_size ?? null, r.recipe_url ?? null, r.photo_path ?? null,
         JSON.stringify(r.ingredients || []), JSON.stringify(r.allergens || []),
         r.prep_time_minutes ?? null, r.cook_time_minutes ?? null, r.difficulty ?? null,
         JSON.stringify(r.suggested_meal_types || []), r.is_favorite ? 1 : 0,
         JSON.stringify(r.alternate_servings || []), JSON.stringify(r.tags || []),
         Date.now(), Date.now()]);
    }
  });

  await step('Workout history', async () => {
    const rows = await api('/user/backup/sessions');
    for (const s of rows) {
      const sid = parseInt(s.local_entity_id, 10);
      if (isNaN(sid)) continue;
      const planId = s.plan_local_id != null ? parseInt(s.plan_local_id, 10) : NaN;
      await db.runAsync(
        `INSERT OR REPLACE INTO workout_sessions
           (id, name, start_time, end_time, duration_sec, notes, plan_id, synced,
            source_assigned_plan_id, local_session_id, user_id, server_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sid, s.name || 'Workout',
         new Date(s.started_at).getTime(),
         s.finished_at ? new Date(s.finished_at).getTime() : null,
         s.duration_seconds ?? null, s.notes ?? null,
         isNaN(planId) ? null : planId, 1,
         s.source_assigned_plan_id ?? null, String(sid), userId, s.id]);
      await db.runAsync('DELETE FROM session_exercises WHERE session_id = ?', [sid]);
      for (let i = 0; i < (s.exercises || []).length; i++) {
        const ex = s.exercises[i] || {};
        if (!ex.exercise_name) continue;
        const exerciseId = await exerciseIdByName(ex.exercise_name, ex.muscle_group);
        const se = await db.runAsync(
          `INSERT INTO session_exercises (session_id, exercise_id, position, rest_seconds, group_id, notes, trainer_note)
           VALUES (?,?,?,?,?,?,?)`,
          [sid, exerciseId, ex.order_index ?? i, ex.rest_seconds ?? 90, ex.group_id ?? null,
           ex.notes ?? null, ex.trainerNote ?? null]);
        for (let j = 0; j < (ex.sets || []).length; j++) {
          const st = ex.sets[j] || {};
          await db.runAsync(
            `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, rpe, set_type, completed)
             VALUES (?,?,?,?,?,?,?,?)`,
            [se.lastInsertRowId, Number(st.weight) || 0, Number(st.reps) || 0,
             st.set_type === 'warmup' ? 1 : 0, st.order_index ?? j, st.rpe ?? null,
             st.set_type || 'working', st.completed === false ? 0 : 1]);
        }
      }
    }
  });

  await step('Diet & supplement plans', async () => {
    const [dietPlans, suppPlans] = await Promise.all([
      api('/user/backup/diet-plans'),
      api('/user/backup/supplement-plans'),
    ]);
    for (const p of dietPlans) {
      await db.runAsync(
        `INSERT OR REPLACE INTO local_diet_plans
           (local_id, server_id, user_id, synced, name, notes, tags,
            daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
            created_at, updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?)`,
        [p.local_entity_id, p.id, userId, p.name, p.notes ?? null, JSON.stringify(p.tags || []),
         p.daily_calorie_target ?? null, p.daily_protein_target ?? null,
         p.daily_carbs_target ?? null, p.daily_fat_target ?? null, Date.now(), Date.now()]);
      for (const d of p.days || []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO local_diet_plan_days (local_id, diet_plan_local_id, day_label, order_index)
           VALUES (?,?,?,?)`,
          [d.local_entity_id, p.local_entity_id, d.day_label, d.order_index ?? 0]);
        for (const m of d.meals || []) {
          await db.runAsync(
            `INSERT OR REPLACE INTO local_diet_plan_meals (local_id, diet_day_local_id, meal_type, order_index, slot_note)
             VALUES (?,?,?,?,?)`,
            [m.local_entity_id, d.local_entity_id, m.meal_type, m.order_index ?? 0, m.slot_note ?? null]);
          for (const it of m.items || []) {
            await db.runAsync(
              `INSERT OR REPLACE INTO local_diet_plan_meal_items
                 (local_id, diet_meal_local_id, local_recipe_id, name, calories, protein_g, carbs_g, fat_g,
                  serving_size, recipe_url, quantity_multiplier, client_note, order_index, photo_path,
                  ingredients, allergens, prep_time_minutes, cook_time_minutes, difficulty,
                  alternate_servings, tags)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
               [it.local_entity_id, m.local_entity_id, it.local_recipe_id ?? null, it.name,
                it.calories ?? null, it.protein_g ?? null, it.carbs_g ?? null, it.fat_g ?? null,
                it.serving_size ?? null, it.recipe_url ?? null, it.quantity_multiplier ?? 1,
                it.client_note ?? null, it.order_index ?? 0, it.photo_path ?? null,
                JSON.stringify(it.ingredients || []), JSON.stringify(it.allergens || []),
                it.prep_time_minutes ?? null, it.cook_time_minutes ?? null, it.difficulty ?? null,
                JSON.stringify(it.alternate_servings || []), JSON.stringify(it.tags || [])]);
            // configured dish alternatives ride inside the item payload
            for (let ai = 0; ai < (it.alternatives || []).length; ai++) {
              const a = it.alternatives[ai];
              await db.runAsync(
                `INSERT INTO local_diet_plan_meal_item_alternatives
                   (local_diet_plan_meal_item_id, alternative_name, alternative_calories,
                    alternative_protein_g, alternative_carbs_g, alternative_fat_g,
                    alternative_recipe_local_id, order_index)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [it.local_entity_id, String(a?.name ?? '').trim(), a?.calories ?? null,
                 a?.protein_g ?? null, a?.carbs_g ?? null, a?.fat_g ?? null,
                 a?.recipe_local_id ?? null, ai]);
            }
          }
        }
      }
    }
    for (const p of suppPlans) {
      await db.runAsync(
        `INSERT OR REPLACE INTO local_supplement_plans
           (local_id, server_id, user_id, synced, name, notes, tags, created_at, updated_at)
         VALUES (?,?,?,1,?,?,?,?,?)`,
        [p.local_entity_id, p.id, userId, p.name, p.notes ?? null, JSON.stringify(p.tags || []), Date.now(), Date.now()]);
      for (const it of p.items || []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO local_supplement_plan_items
             (local_id, supplement_plan_local_id, supplement_name, dosage, timing, notes, order_index)
           VALUES (?,?,?,?,?,?,?)`,
          [it.local_entity_id, p.local_entity_id, it.supplement_name, it.dosage ?? null,
           it.timing ?? null, it.notes ?? null, it.order_index ?? 0]);
      }
    }
  // ── Diet food diaries (log-first + legacy detailed-mode logs) ──────────
  // These were previously MISSING from the restore: uploads reached Postgres
  // and "backup" reported success, but a fresh install restored an empty
  // diary. Restored rows are marked synced (they ARE the server truth) and
  // keep their local ids, so later edits upsert in place instead of
  // duplicating (idempotent under repeated restores).

  await step('Food diary', async () => {
    const rows = await api('/user/backup/food-log-entries');
    for (const e of rows) {
      await db.runAsync(
        `INSERT OR REPLACE INTO food_log_entries
           (local_id, user_id, server_id, synced, log_date, meal_type, name,
            calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
            quantity, serving_unit, food_source_type, food_source_id,
            suggested_by_trainer, logged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [e.local_entity_id, userId, e.id, 1, String(e.log_date).slice(0, 10),
         e.meal_type || 'other', e.name,
         e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
         e.fiber_g ?? null, e.sugar_g ?? null, e.sodium_mg ?? null,
         e.quantity ?? 1, e.serving_unit || 'serving', e.food_source_type || 'manual',
         e.food_source_id ?? null, e.suggested_by_trainer ? 1 : 0,
         e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]);
    }
  });

  await step('Detailed plan food logs', async () => {
    // Legacy detailed-mode entries (pre-log-first): restore into the old
    // plan-scoped table for the plan detail screens AND map them into the
    // log-first diary so the Diet tab shows the same history (the same
    // mapping the v39 local migration applied to never-cleared devices).
    const rows = await api('/user/backup/food-log').catch(() => []);
    for (const e of rows) {
      const mealType = ['breakfast', 'lunch', 'dinner', 'snack'].includes(
        String(e.meal_type || '').toLowerCase()
      ) ? String(e.meal_type).toLowerCase() : 'other';
      await db.runAsync(
        `INSERT OR REPLACE INTO local_food_log_entries
           (local_id, user_id, server_id, synced, plan_ref, plan_version_id, log_date, meal_type,
            source, planned_item_ref, name, calories, protein_g, carbs_g, fat_g,
            serving_size, quantity, logged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [e.local_entity_id, userId, e.id, 1, e.plan_ref ?? null, e.plan_version_id ?? null,
         String(e.log_date).slice(0, 10), e.meal_type || null, e.source || 'free_logged',
         e.planned_item_ref ?? null, e.name,
         e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
         e.serving_size ?? null, e.quantity ?? 1,
         e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]);
      // map into the log-first diary (same rules as migration v39)
      await db.runAsync(
        `INSERT OR IGNORE INTO food_log_entries
           (local_id, user_id, server_id, synced, log_date, meal_type, name,
            calories, protein_g, carbs_g, fat_g, quantity, serving_unit,
            food_source_type, food_source_id, logged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`legacy_${e.local_entity_id}`, userId, null, 1, String(e.log_date).slice(0, 10),
         mealType, e.name,
         e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
         e.quantity ?? 1, 'serving', 'manual', e.planned_item_ref ?? null,
         e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]);
    }
  });

  await step('Custom dishes', async () => {
    const rows = await api('/user/backup/custom-dishes');
    for (const d of rows) {
      await db.runAsync(
        `INSERT OR REPLACE INTO custom_dishes
           (local_id, user_id, server_id, synced, name, total_servings, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [d.local_entity_id, userId, d.id, 1, d.name, d.total_servings || 1, Date.now(), Date.now()]);
      await db.runAsync(
        'DELETE FROM custom_dish_ingredients WHERE custom_dish_local_id = ?',
        [d.local_entity_id]);
      for (let i = 0; i < (d.ingredients || []).length; i++) {
        const ing = d.ingredients[i];
        await db.runAsync(
          `INSERT INTO custom_dish_ingredients
             (custom_dish_local_id, global_food_id, ingredient_name, quantity, unit,
              calories_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot, order_index)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [d.local_entity_id, ing.global_food_id ?? null, ing.ingredient_name,
           ing.quantity ?? 0, ing.unit || 'g',
           ing.calories_snapshot ?? 0, ing.protein_g_snapshot ?? 0,
           ing.carbs_g_snapshot ?? 0, ing.fat_g_snapshot ?? 0, i]);
      }
    }
  });

    const [dietCis, suppCis, dietSwaps] = await Promise.all([
      api('/user/backup/diet-checkins'),
      api('/user/backup/supplement-checkins'),
      api('/user/backup/diet-swaps').catch(() => []),
    ]);
    for (const s of dietSwaps) {
      // swaps restore as already-synced — they ARE the server truth
      await db.runAsync(
        `INSERT INTO local_diet_item_swaps
           (user_id, diet_plan_meal_item_ref, plan_ref, swap_date, original_name,
            swapped_name, swapped_calories, swapped_protein_g, swapped_carbs_g,
            swapped_fat_g, synced, server_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
         ON CONFLICT(diet_plan_meal_item_ref, swap_date) DO UPDATE SET
           plan_ref = excluded.plan_ref,
           original_name = excluded.original_name,
           swapped_name = excluded.swapped_name,
           swapped_calories = excluded.swapped_calories,
           swapped_protein_g = excluded.swapped_protein_g,
           swapped_carbs_g = excluded.swapped_carbs_g,
           swapped_fat_g = excluded.swapped_fat_g,
           synced = 1, server_id = excluded.server_id`,
        [userId, s.diet_plan_meal_item_ref, s.plan_ref, String(s.swap_date).slice(0, 10),
         s.original_name, s.swapped_name, s.swapped_calories ?? null,
         s.swapped_protein_g ?? null, s.swapped_carbs_g ?? null, s.swapped_fat_g ?? null,
         s.id]);
    }
    for (const c of dietCis) {
      await db.runAsync(
        `INSERT INTO local_diet_checkins (user_id, diet_plan_local_id, date, followed, note, synced)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(diet_plan_local_id, date) DO UPDATE SET
           followed = excluded.followed, note = excluded.note, synced = 1`,
        [userId, c.diet_plan_local_id, c.date, c.followed ? 1 : 0, c.note ?? null]);
    }
    for (const c of suppCis) {
      await db.runAsync(
        `INSERT INTO local_supplement_checkins (user_id, supplement_plan_local_id, date, taken, note, synced)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(supplement_plan_local_id, date) DO UPDATE SET
           taken = excluded.taken, note = excluded.note, synced = 1`,
        [userId, c.supplement_plan_local_id, c.date, c.taken ? 1 : 0, c.note ?? null]);
    }
  });

  await step('Trainer content', async () => {
    // server-truth trainer content → offline cache (one-way; never uploaded)
    const [assigned, dietAssigned, suppAssigned] = await Promise.all([
      api('/client/assigned-plans').catch(() => null),
      api('/client/diet-plans').then((r) => (r || []).filter((p) => p.created_by === 'trainer')).catch(() => null),
      api('/client/supplement-plans').then((r) => (r || []).filter((p) => p.created_by === 'trainer')).catch(() => null),
    ]);
    const entries = [
      ['trainer:assigned-workouts', assigned],
      ['trainer:diet-plans', dietAssigned],
      ['trainer:supplement-plans', suppAssigned],
    ];
    for (const [key, val] of entries) {
      if (val == null) continue; // endpoint unavailable (e.g. trainer role) — not a failure
      await db.runAsync(
        `INSERT OR REPLACE INTO sync_cache (user_id, cache_key, payload, last_fetched_at) VALUES (?,?,?,?)`,
        [userId, key, JSON.stringify(val), Date.now()]);
    }
  });

  await step('Body measurements', async () => {
    const rows = await api('/user/backup/measurements');
    for (const m of rows) {
      await db.runAsync(
        `INSERT INTO body_metrics (user_id, date, metric_type, value, unit, synced)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(user_id, date, metric_type) DO UPDATE SET
           value = excluded.value, unit = excluded.unit, synced = 1`,
        [userId, m.date, m.metric_type, Number(m.value), m.unit || '']);
    }
  });

  await step('Personal records', async () => {
    const rows = await api('/user/backup/personal-records');
    for (const r of rows) {
      const exerciseId = await exerciseIdByName(r.exercise_name, null);
      const prId = parseInt(r.local_entity_id, 10);
      await db.runAsync(
        `INSERT OR REPLACE INTO personal_records
           (id, exercise_id, record_type, value, secondary_value, set_id, achieved_at, exercise_name, synced, server_id)
         VALUES (?,?,?,?,?,?,?,?,1,?)`,
        [isNaN(prId) ? null : prId, exerciseId, r.record_type, Number(r.value),
         r.secondary_value ?? null, 0,
         r.achieved_at ? new Date(r.achieved_at).toISOString() : new Date().toISOString(),
         r.exercise_name, r.id]);
    }
  });


    await step('Progress photos', async (onDetail) => {
    // FIRST-CLASS endpoint (visibility-aware), not the old backup route.
    // Each row carries image_path — the authorized stream endpoint. The
    // image is fetched WITH the JWT header (RN fetch → base64 → cached
    // locally), and the row records both the cache file and the server
    // path: display uses the local cache offline-first, server-truth
    // whenever the cache is missing.
    const rows = await api('/progress-photos');
    if (!rows.length) return;
    const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });

    const downloadAuthorized = async (imagePath) => {
      try {
        const token = await getAccessToken();
        const res = await global.fetch(`${API_BASE}${imagePath}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const blob = await res.blob();
        // blob → base64 via RN's FileReader (works on Android/iOS)
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const s = String(reader.result || '');
            const idx = s.indexOf('base64,');
            resolve(idx >= 0 ? s.slice(idx + 7) : null);
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    };

    for (let i = 0; i < rows.length; i++) {
      const ph = rows[i];
      onDetail(`Downloading photos… ${i + 1} of ${rows.length}`);
      const filename = `${ph.photo_date}_restore_${i}.jpg`;
      const dest = `${PHOTOS_DIR}${filename}`;
      const info = await FileSystem.getInfoAsync(dest);
      if (!info.exists && ph.image_path) {
        const b64 = await downloadAuthorized(ph.image_path);
        if (b64) {
          await FileSystem.writeAsStringAsync(dest, b64, {
            encoding: FileSystem.EncodingType.Base64,
          }).catch(() => {});
        }
      }
      const cached = await FileSystem.getInfoAsync(dest);
            // skip rows with neither a local cache nor a server path — nothing
      // displayable, and inserting them would create ghost entries
      if (!cached.exists && !ph.image_path) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO progress_photos
           (id, date, file_path, angle, visibility, image_path, created_at, synced, server_id)
         VALUES (?,?,?,?,?,?,?,?,1)`,
        [Date.now() + i, ph.photo_date, cached.exists ? filename : null, null,
         ph.visibility || 'PERSONAL', ph.image_path || null,
         new Date().toISOString(), ph.id]);
    }
  });

  await setRestoreFlag(userId);
}