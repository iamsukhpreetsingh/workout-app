// customDishes.js — local-first ingredient-based dish builder (Phase 3).
// Ingredient macros are SNAPSHOTS at add-time: editing a saved dish never
// retroactively changes already-logged entries that used it (same snapshot
// principle as every catalog-sourced value in this app).
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { api } from '../lib/api';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const newLocalId = () => `dish_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Pure per-dish math used by the builder UI AND by tests (mirrors the
// server's per-serving derivation in nutritionLog.searchFoods).
export function dishTotals(ingredients, totalServings = 1) {
  const sum = (key) =>
    (ingredients || []).reduce((n, i) => n + (Number(i[`${key}_snapshot`] ?? i[key]) || 0), 0);
  const servings = Number(totalServings) || 1;
  const total = {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g') * 10) / 10,
    carbs_g: Math.round(sum('carbs_g') * 10) / 10,
    fat_g: Math.round(sum('fat_g') * 10) / 10,
  };
  const per = (v) => Math.round((v / servings) * 10) / 10;
  return {
    total,
    perServing: {
      calories: per(total.calories),
      protein_g: per(total.protein_g),
      carbs_g: per(total.carbs_g),
      fat_g: per(total.fat_g),
    },
  };
}

export async function saveDish({ localId, name, totalServings = 1, ingredients = [] }) {
  if (!name || !String(name).trim()) throw new Error('Dish name is required');
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const id = localId || newLocalId();
  const now = Date.now();
  await db.runAsync(
    `INSERT OR REPLACE INTO custom_dishes (local_id, user_id, synced, name, total_servings, created_at, updated_at)
     VALUES (?,?,0,?,?,?,?)`,
    [id, userId, String(name).trim(), Number(totalServings) || 1, now, now]
  );
  await db.runAsync('DELETE FROM custom_dish_ingredients WHERE custom_dish_local_id = ?', [id]);
  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    if (!ing?.ingredient_name) continue;
    await db.runAsync(
      `INSERT INTO custom_dish_ingredients
         (custom_dish_local_id, global_food_id, ingredient_name, quantity, unit,
          calories_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot, order_index)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, ing.global_food_id || null, String(ing.ingredient_name), Number(ing.quantity) || 0,
       ing.unit || 'g', Number(ing.calories_snapshot) || 0, Number(ing.protein_g_snapshot) || 0,
       Number(ing.carbs_g_snapshot) || 0, Number(ing.fat_g_snapshot) || 0, i]
    );
  }
  await enqueueUpsert('custom_dish', id);
  return id;
}

// Fresh-install hydration safety net: if this user has no local dishes,
// pull the server copy once (restore step is the primary mechanism; this
// covers skipped gates and timing gaps — same pattern as My Dishes recipes).
let dishesLoadPromise = null;
export async function ensureDishesLoaded() {
  const userId = getCurrentUserId();
  if (!userId) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM custom_dishes WHERE user_id = ?', [userId]);
  if (row.c > 0) return;
  if (dishesLoadPromise) return dishesLoadPromise;
  dishesLoadPromise = (async () => {
    try {
      const remote = await api('/user/backup/custom-dishes');
      const db2 = await getDb();
      for (const d of remote || []) {
        await db2.runAsync(
          `INSERT OR REPLACE INTO custom_dishes
             (local_id, user_id, server_id, synced, name, total_servings, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [d.local_entity_id, userId, d.id, 1, d.name, d.total_servings || 1, Date.now(), Date.now()]
        );
        const have = await db2.getFirstAsync(
          'SELECT COUNT(*) AS c FROM custom_dish_ingredients WHERE custom_dish_local_id = ?',
          [d.local_entity_id]
        );
        if (have.c === 0) {
          for (let i = 0; i < (d.ingredients || []).length; i++) {
            const ing = d.ingredients[i];
            await db2.runAsync(
              `INSERT INTO custom_dish_ingredients
                 (custom_dish_local_id, global_food_id, ingredient_name, quantity, unit,
                  calories_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot, order_index)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [d.local_entity_id, ing.global_food_id ?? null, ing.ingredient_name,
               ing.quantity ?? 0, ing.unit || 'g',
               ing.calories_snapshot ?? 0, ing.protein_g_snapshot ?? 0,
               ing.carbs_g_snapshot ?? 0, ing.fat_g_snapshot ?? 0, i]
            );
          }
        }
      }
    } catch {
      // offline — local view stands, retried next read
    } finally {
      dishesLoadPromise = null;
    }
  })();
  return dishesLoadPromise;
}

export async function listDishes() {
  await ensureDishesLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const dishes = await db.getAllAsync(
    'SELECT * FROM custom_dishes WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
  for (const d of dishes) {
    d.ingredients = await db.getAllAsync(
      'SELECT * FROM custom_dish_ingredients WHERE custom_dish_local_id = ? ORDER BY order_index',
      [d.local_id]);
    d.local_entity_id = d.local_id;
  }
  return dishes;
}

export async function getDish(localId) {
  await ensureDishesLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  const d = await db.getFirstAsync(
    'SELECT * FROM custom_dishes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  if (!d) return null;
  d.ingredients = await db.getAllAsync(
    'SELECT * FROM custom_dish_ingredients WHERE custom_dish_local_id = ? ORDER BY order_index',
    [localId]);
  d.local_entity_id = d.local_id;
  return d;
}

export async function deleteDish(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM custom_dishes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await db.runAsync('DELETE FROM custom_dish_ingredients WHERE custom_dish_local_id = ?', [localId]);
  await db.runAsync('DELETE FROM custom_dishes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('custom_dish', localId, !!row?.server_id);
}
