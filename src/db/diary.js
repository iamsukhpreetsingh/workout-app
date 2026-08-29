// diary.js — LOG-FIRST local food diary ("what I actually ate", scoped to
// the USER + date — never to a plan; migration v39). Local-first: every
// write is SQLite + a queued backup upsert, so logging works fully offline.
// The old plan-scoped module (foodLog.js) still serves the legacy plan
// detail screens; this module backs the Diet tab.
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { api } from '../lib/api';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';
import { buildRecentFoods } from '../features/diet/domain/nutritionCore';
import { isFutureDate } from '../lib/checkinDates';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
export const FOOD_SOURCE_TYPES = ['global_database', 'personal_recipe', 'trainer_recipe', 'custom_dish', 'manual'];

const newLocalId = () => `fle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// §24 Rule 1 — future food logging is forbidden. Today and past dates are
// loggable/editable (backfill); future dates are blocked at the DATA LAYER,
// not just the UI, so no code path can create a future entry.
export function canLogFoodForDate(date, today = null) {
  return !isFutureDate(date, today ?? undefined);
}

export async function logFoodEntry({
  date,
  mealType = 'other',
  name,
  calories = null,
  protein_g = null,
  carbs_g = null,
  fat_g = null,
  fiber_g = null,
  sugar_g = null,
  sodium_mg = null,
  quantity = 1,
  servingUnit = 'serving',
  foodSourceType = 'manual',
  foodSourceId = null,
  suggestedByTrainer = false,
}) {
  if (!name || !String(name).trim()) throw new Error('Food name is required');
  if (!date) throw new Error('date is required');
  if (!canLogFoodForDate(date)) throw new Error('Food cannot be logged for a future date');
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const localId = newLocalId();
  await db.runAsync(
    `INSERT INTO food_log_entries
       (local_id, user_id, synced, log_date, meal_type, name, calories, protein_g, carbs_g, fat_g,
        fiber_g, sugar_g, sodium_mg, quantity, serving_unit, food_source_type, food_source_id,
        suggested_by_trainer, logged_at)
     VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [localId, userId, date, MEAL_TYPES.includes(mealType) ? mealType : 'other', String(name).trim(),
     calories ?? null, protein_g ?? null, carbs_g ?? null, fat_g ?? null,
     fiber_g ?? null, sugar_g ?? null, sodium_mg ?? null,
     Number(quantity) || 1, servingUnit || 'serving',
     FOOD_SOURCE_TYPES.includes(foodSourceType) ? foodSourceType : 'manual',
     foodSourceId != null ? String(foodSourceId) : null,
     suggestedByTrainer ? 1 : 0, Date.now()]
  );
  await enqueueUpsert('food_log', localId);
  return localId;
}

export async function updateFoodEntry(localId, patch) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT * FROM food_log_entries WHERE local_id = ? AND user_id = ?', [localId, userId]);
  if (!row) return;
  const next = { ...row, ...patch };
  await db.runAsync(
    `UPDATE food_log_entries SET meal_type=?, name=?, calories=?, protein_g=?, carbs_g=?, fat_g=?,
       quantity=?, serving_unit=?, synced=0, logged_at=? WHERE local_id=? AND user_id=?`,
    [next.meal_type, next.name, next.calories, next.protein_g, next.carbs_g, next.fat_g,
     next.quantity, next.serving_unit, Date.now(), localId, userId]
  );
  await enqueueUpsert('food_log', localId);
}

export async function deleteFoodEntry(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM food_log_entries WHERE local_id = ? AND user_id = ?', [localId, userId]);
  if (!row) return;
  await db.runAsync('DELETE FROM food_log_entries WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('food_log', localId, !!row.server_id);
}

function hydrate(r) {
  return {
    local_id: r.local_id, id: r.local_id, log_date: r.log_date, meal_type: r.meal_type,
    name: r.name, calories: r.calories, protein_g: r.protein_g, carbs_g: r.carbs_g,
    fat_g: r.fat_g, fiber_g: r.fiber_g, sugar_g: r.sugar_g, sodium_mg: r.sodium_mg,
    quantity: r.quantity, serving_unit: r.serving_unit,
    food_source_type: r.food_source_type, food_source_id: r.food_source_id,
    suggested_by_trainer: r.suggested_by_trainer === 1, logged_at: r.logged_at,
  };
}

// Fresh-install hydration safety net (mirrors ensureRecipesLoaded): if this
// user has ZERO local diary rows, pull the server copy once. This covers
// paths that bypass the login restore gate — the restore step is the
// primary mechanism, this is the retry. Rows restore as synced (they ARE
// the server truth) with their local ids, so edits upsert in place.
let diaryLoadPromise = null;
export async function ensureDiaryLoaded() {
  const userId = getCurrentUserId();
  if (!userId) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM food_log_entries WHERE user_id = ?', [userId]);
  if (row.c > 0) return;
  if (diaryLoadPromise) return diaryLoadPromise;
  diaryLoadPromise = (async () => {
    try {
      const remote = await api('/user/backup/food-log-entries');
      const db2 = await getDb();
      for (const e of remote || []) {
        await db2.runAsync(
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
           e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]
        );
      }
    } catch {
      // offline / auth hiccup — local view stands, retried next read
    } finally {
      diaryLoadPromise = null;
    }
  })();
  return diaryLoadPromise;
}

export async function listEntriesForDate(date) {
  await ensureDiaryLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId || !date) return [];
  const rows = await db.getAllAsync(
    'SELECT * FROM food_log_entries WHERE user_id = ? AND log_date = ? ORDER BY logged_at ASC',
    [userId, date]
  );
  return rows.map(hydrate);
}

// inclusive range for the trend view (oldest → newest)
export async function listEntriesBetween(fromDate, toDate) {
  await ensureDiaryLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = await db.getAllAsync(
    `SELECT * FROM food_log_entries WHERE user_id = ? AND log_date >= ? AND log_date <= ?
     ORDER BY log_date ASC, logged_at ASC`,
    [userId, fromDate, toDate]
  );
  return rows.map(hydrate);
}

// Recent (latest quantity per food) + Frequent (most-logged) — Phase 4's
// low-friction re-logging surfaces. Derived from the diary itself.
export async function getRecentAndFrequent(limit = 10) {
  await ensureDiaryLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return { recent: [], frequent: [] };
  const rows = await db.getAllAsync(
    'SELECT * FROM food_log_entries WHERE user_id = ? ORDER BY logged_at DESC LIMIT 500',
    [userId]
  );
  const hydrated = rows.map(hydrate);
  const recent = buildRecentFoods(hydrated, limit);
  const counts = new Map();
  for (const e of hydrated) {
    const key = String(e.name || '').trim().toLowerCase();
    if (!key) continue;
    const cur = counts.get(key) || { name: e.name, times: 0, sample: e };
    cur.times += 1;
    counts.set(key, cur);
  }
  const frequent = [...counts.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, limit)
    .map((f) => ({ ...f.sample, times_logged: f.times }));
  return { recent, frequent };
}
