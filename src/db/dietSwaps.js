// Date-scoped diet item swaps ("on 2026-08-24 I actually ate X instead of
// Y"). Unlike a workout swap — session-scoped, logged once and done — a
// diet plan is followed day after day, so every swap here is keyed to an
// exact calendar date via UNIQUE(diet_plan_meal_item_ref, swap_date).
// Swapping Monday never touches Tuesday: the underlying plan definition is
// never modified.
//
// plan_ref / diet_plan_meal_item_ref hold LOCAL ids for self-authored plans
// or SERVER uuids for trainer-assigned plans (those plans are server-truth
// and are not stored in the local_* tables). Every swap — self-authored or
// trainer-assigned — is backed up to /user/backup/diet-swaps so a device
// change loses nothing; only ASSIGNED-plan swaps are surfaced to trainers
// server-side (the trainer query filters on plan_server_id).
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const swapEntityId = (itemRef, date) => `${itemRef}|${date}`;

export async function swapDietItem({
  planRef,
  itemRef,
  originalName,
  date,
  swapped,
}) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  await db.runAsync(
    `INSERT INTO local_diet_item_swaps
       (user_id, diet_plan_meal_item_ref, plan_ref, swap_date, original_name,
        swapped_name, swapped_calories, swapped_protein_g, swapped_carbs_g,
        swapped_fat_g, from_alternative_id, synced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(diet_plan_meal_item_ref, swap_date) DO UPDATE SET
       plan_ref = excluded.plan_ref,
       original_name = excluded.original_name,
       swapped_name = excluded.swapped_name,
       swapped_calories = excluded.swapped_calories,
       swapped_protein_g = excluded.swapped_protein_g,
       swapped_carbs_g = excluded.swapped_carbs_g,
       swapped_fat_g = excluded.swapped_fat_g,
       from_alternative_id = excluded.from_alternative_id,
       synced = 0`,
    [userId, String(itemRef), String(planRef), date, String(originalName),
     String(swapped?.name || '').trim(),
     swapped?.calories ?? null, swapped?.protein_g ?? null,
     swapped?.carbs_g ?? null, swapped?.fat_g ?? null,
     swapped?.from_alternative_id ?? null]
  );
  await enqueueUpsert('diet_swap', swapEntityId(itemRef, date));
}

export async function undoDietSwap(itemRef, date) {
  const db = await getDb();
  const row = await db.getFirstAsync(
    'SELECT * FROM local_diet_item_swaps WHERE diet_plan_meal_item_ref = ? AND swap_date = ?',
    [String(itemRef), date]
  );
  if (!row) return;
  await db.runAsync(
    'DELETE FROM local_diet_item_swaps WHERE id = ?', [row.id]);
  // Only bother the queue if this swap ever reached the server.
  if (row.synced || row.server_id) {
    await enqueueDelete('diet_swap', swapEntityId(itemRef, date), !!row.server_id);
  }
}

// map of itemRef -> swap row for one viewed date (drives the detail screen)
export async function getSwapsForDate(planRef, date) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    'SELECT * FROM local_diet_item_swaps WHERE plan_ref = ? AND swap_date = ?',
    [String(planRef), date]
  );
  const map = new Map();
  for (const r of rows) map.set(r.diet_plan_meal_item_ref, r);
  return map;
}

export async function getSwapForItem(itemRef, date) {
  const db = await getDb();
  return db.getFirstAsync(
    'SELECT * FROM local_diet_item_swaps WHERE diet_plan_meal_item_ref = ? AND swap_date = ?',
    [String(itemRef), date]
  );
}

// full history (newest first) — trainer-facing "Recent substitutions" and
// debugging; used locally regardless of plan type
export async function listSwapsForPlan(planRef, limit = 30) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM local_diet_item_swaps WHERE plan_ref = ?
     ORDER BY swap_date DESC, id DESC LIMIT ?`,
    [String(planRef), limit]
  );
  return rows;
}
