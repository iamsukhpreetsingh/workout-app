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
import { api } from '../lib/api';
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

// Fresh-install hydration safety net for the LEGACY plan-scoped detailed
// diary (pre-log-first entries). Restores into local_food_log_entries (the
// plan detail screens' source) AND maps into the log-first diary so the
// Diet tab shows the same history — the same mapping the v39 migration
// applied to never-cleared devices.
let legacyLoadPromise = null;
export async function ensureLegacyFoodLogLoaded() {
  const userId = getCurrentUserId();
  if (!userId) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM local_food_log_entries WHERE user_id = ?', [userId]);
  if (row.c > 0) return;
  if (legacyLoadPromise) return legacyLoadPromise;
  legacyLoadPromise = (async () => {
    try {
      const remote = await api('/user/backup/food-log');
      const db2 = await getDb();
      for (const e of remote || []) {
        const mealType = ['breakfast', 'lunch', 'dinner', 'snack'].includes(String(e.meal_type || '').toLowerCase())
          ? String(e.meal_type).toLowerCase() : 'other';
        await db2.runAsync(
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
           e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]
        );
        // map into the log-first diary (same rules as the v39 migration)
        await db2.runAsync(
          `INSERT OR IGNORE INTO food_log_entries
             (local_id, user_id, server_id, synced, log_date, meal_type, name,
              calories, protein_g, carbs_g, fat_g, quantity, serving_unit,
              food_source_type, food_source_id, logged_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [`legacy_${e.local_entity_id}`, userId, null, 1, String(e.log_date).slice(0, 10),
           mealType, e.name,
           e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
           e.quantity ?? 1, 'serving', 'manual', e.planned_item_ref ?? null,
           e.logged_at ? new Date(e.logged_at).getTime() : Date.now()]
        );
      }
    } catch {
      // offline — local view stands, retried next read
    } finally {
      legacyLoadPromise = null;
    }
  })();
  return legacyLoadPromise;
}

export async function listFoodLogsForDate(planRef, date) {
  await ensureLegacyFoodLogLoaded();
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
  await ensureLegacyFoodLogLoaded();
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
