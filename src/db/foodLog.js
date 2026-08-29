// Local-first FOOD DIARY data access ("what I actually ate" — reality, not
// the plan). Every write is local SQLite + a queued backup upsert, so food
// logging works fully offline. plan_ref holds the LOCAL plan id for
// self-authored plans or the SERVER uuid for trainer-assigned plans
// (mirroring dietSwaps) — the sync handler derives plan_server_id from it.
//
// The raw entries are the source of truth; daily totals/statuses are always
// DERIVED from them (nutritionCore.computeDailySummary), never stored as an
// authoritative adherence score.
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';
import { buildRecentFoods } from '../features/diet/domain/nutritionCore';

const newLocalId = () => `fl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const FOOD_SOURCES = ['planned', 'swapped', 'extra', 'free_logged'];

// Human-friendly source context (§36 — never expose raw enum labels).
export const SOURCE_LABELS = {
  planned: 'As planned',
  swapped: 'Swapped',
  extra: 'Added',
  free_logged: 'Logged manually',
};

export async function logFood({
  planRef,
  planVersionId = null,
  date,
  mealType = null,
  source = 'free_logged',
  plannedItemRef = null,
  name,
  calories = null,
  protein_g = null,
  carbs_g = null,
  fat_g = null,
  serving_size = null,
  quantity = 1,
}) {
  if (!name || !String(name).trim()) throw new Error('Food name is required');
  if (!planRef) throw new Error('planRef is required');
  if (!date) throw new Error('date is required');
  if (!FOOD_SOURCES.includes(source)) throw new Error(`Invalid food source: ${source}`);
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const localId = newLocalId();
  await db.runAsync(
    `INSERT INTO local_food_log_entries
       (local_id, user_id, synced, plan_ref, plan_version_id, log_date, meal_type,
        source, planned_item_ref, name, calories, protein_g, carbs_g, fat_g,
        serving_size, quantity, logged_at)
     VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [localId, userId, String(planRef), planVersionId ?? null, date, mealType ?? null,
     source, plannedItemRef != null ? String(plannedItemRef) : null, String(name).trim(),
     calories ?? null, protein_g ?? null, carbs_g ?? null, fat_g ?? null,
     serving_size ?? null, Number(quantity) || 1, Date.now()]
  );
  await enqueueUpsert('diet_food_log', localId);
  return localId;
}

export async function deleteFoodLog(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM local_food_log_entries WHERE local_id = ? AND user_id = ?',
    [localId, userId]
  );
  if (!row) return;
  await db.runAsync('DELETE FROM local_food_log_entries WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('diet_food_log', localId, !!row.server_id);
}

function hydrate(r) {
  return {
    local_id: r.local_id,
    id: r.local_id,
    plan_ref: r.plan_ref,
    plan_version_id: r.plan_version_id,
    log_date: r.log_date,
    meal_type: r.meal_type,
    source: r.source,
    planned_item_ref: r.planned_item_ref,
    name: r.name,
    calories: r.calories,
    protein_g: r.protein_g,
    carbs_g: r.carbs_g,
    fat_g: r.fat_g,
    serving_size: r.serving_size,
    quantity: r.quantity,
    logged_at: r.logged_at,
  };
}

export async function listFoodLogsForDate(planRef, date) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId || !planRef || !date) return [];
  const rows = await db.getAllAsync(
    `SELECT * FROM local_food_log_entries
     WHERE user_id = ? AND plan_ref = ? AND log_date = ?
     ORDER BY logged_at ASC`,
    [userId, String(planRef), date]
  );
  return rows.map(hydrate);
}

// Inclusive date range — the history strip / weekly summary source.
export async function listFoodLogsBetween(planRef, fromDate, toDate) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId || !planRef) return [];
  const rows = await db.getAllAsync(
    `SELECT * FROM local_food_log_entries
     WHERE user_id = ? AND plan_ref = ? AND log_date >= ? AND log_date <= ?
     ORDER BY log_date ASC, logged_at ASC`,
    [userId, String(planRef), fromDate, toDate]
  );
  return rows.map(hydrate);
}

// Recent foods + quantity memory (§15/§16): derived from the diary itself —
// the last-used quantity comes back preloaded for one-tap re-logging.
export async function getRecentFoods(limit = 8) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = await db.getAllAsync(
    `SELECT * FROM local_food_log_entries WHERE user_id = ?
     ORDER BY logged_at DESC LIMIT 400`,
    [userId]
  );
  // group by normalized name, keep most recent — the core owns the rule so
  // the backend monitor reuses the identical logic
  return buildRecentFoods(rows.map(hydrate), limit);
}
