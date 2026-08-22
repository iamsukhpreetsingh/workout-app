// Local-first data access for the user's personal recipe catalog (My
// Dishes). Every write is local SQLite + a queued backup upsert — creating
// or editing a dish works fully offline. ensureRecipesLoaded() does a
// one-time pull of the server copy (including dishes migrated from the old
// server-first system by backend migration 025) so existing users see
// their dishes immediately; the Phase-4 restore is the authoritative refill
// for fresh installs.
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { api } from '../lib/api';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const parse = (v) => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};
const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);

function newLocalId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

let loadPromise = null;
export async function ensureRecipesLoaded() {
  const userId = getCurrentUserId();
  if (!userId) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM local_recipes WHERE user_id = ?', [userId]);
  if (row.c > 0) return; // already populated
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const remote = await api('/user/backup/recipes');
      const db2 = await getDb();
      for (const r of remote || []) {
        await db2.runAsync(
          `INSERT OR IGNORE INTO local_recipes
             (local_id, server_id, user_id, synced, name, description, prep_notes,
              calories, protein_g, carbs_g, fat_g, serving_size, recipe_url, photo_path,
              ingredients, allergens, prep_time_minutes, cook_time_minutes, difficulty,
              suggested_meal_types, is_favorite, alternate_servings, tags,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.local_entity_id, r.id, userId, 1, r.name, r.description ?? null, r.prep_notes ?? null,
           r.calories ?? null, r.protein_g ?? null, r.carbs_g ?? null, r.fat_g ?? null,
           r.serving_size ?? null, r.recipe_url ?? null, r.photo_path ?? null,
           arr(r.ingredients), arr(r.allergens), r.prep_time_minutes ?? null,
           r.cook_time_minutes ?? null, r.difficulty ?? null, arr(r.suggested_meal_types),
           r.is_favorite ? 1 : 0, JSON.stringify(r.alternate_servings || []),
           arr(r.tags), Date.now(), Date.now()]
        );
      }
    } catch {
      // offline / auth hiccup — the local (possibly empty) view stands;
      // retried on next screen open
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

// id alias = local_id, so DishForm (which branches on dish.id) keeps working
function hydrate(r) {
  return {
    ...r,
    id: r.local_id,
    ingredients: parse(r.ingredients),
    allergens: parse(r.allergens),
    suggested_meal_types: parse(r.suggested_meal_types),
    alternate_servings: parse(r.alternate_servings),
    tags: parse(r.tags),
    is_favorite: r.is_favorite === 1,
  };
}

export async function listRecipes() {
  await ensureRecipesLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = await db.getAllAsync(
    'SELECT * FROM local_recipes WHERE user_id = ? ORDER BY name', [userId]);
  return rows.map(hydrate);
}

export async function createRecipe(item) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const localId = newLocalId();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO local_recipes
       (local_id, user_id, synced, name, description, prep_notes, calories, protein_g,
        carbs_g, fat_g, serving_size, recipe_url, photo_path, ingredients, allergens,
        prep_time_minutes, cook_time_minutes, difficulty, suggested_meal_types,
        is_favorite, alternate_servings, tags, created_at, updated_at)
     VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [localId, userId, String(item.name || '').trim(), item.description ?? null, item.prep_notes ?? null,
     item.calories ?? null, item.protein_g ?? null, item.carbs_g ?? null, item.fat_g ?? null,
     item.serving_size ?? null, item.recipe_url ?? null, item.photo_path ?? null,
     arr(item.ingredients), arr(item.allergens), item.prep_time_minutes ?? null,
     item.cook_time_minutes ?? null, item.difficulty ?? null, arr(item.suggested_meal_types),
     item.is_favorite ? 1 : 0, JSON.stringify(Array.isArray(item.alternate_servings) ? item.alternate_servings : []),
     arr(item.tags), now, now]
  );
  await enqueueUpsert('recipe', localId);
  return localId;
}

export async function updateRecipe(localId, item) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    `UPDATE local_recipes SET
       name = ?, description = ?, prep_notes = ?, calories = ?, protein_g = ?, carbs_g = ?,
       fat_g = ?, serving_size = ?, recipe_url = ?, photo_path = ?, ingredients = ?, allergens = ?,
       prep_time_minutes = ?, cook_time_minutes = ?, difficulty = ?, suggested_meal_types = ?,
       is_favorite = ?, alternate_servings = ?, tags = ?, synced = 0, updated_at = ?
     WHERE local_id = ? AND user_id = ?`,
    [String(item.name || '').trim(), item.description ?? null, item.prep_notes ?? null,
     item.calories ?? null, item.protein_g ?? null, item.carbs_g ?? null, item.fat_g ?? null,
     item.serving_size ?? null, item.recipe_url ?? null, item.photo_path ?? null,
     arr(item.ingredients), arr(item.allergens), item.prep_time_minutes ?? null,
     item.cook_time_minutes ?? null, item.difficulty ?? null, arr(item.suggested_meal_types),
     item.is_favorite ? 1 : 0, JSON.stringify(Array.isArray(item.alternate_servings) ? item.alternate_servings : []),
     arr(item.tags), Date.now(), localId, userId]
  );
  await enqueueUpsert('recipe', localId);
}

export async function getRecipe(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  const row = await db.getFirstAsync(
    'SELECT * FROM local_recipes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  return row ? hydrate(row) : null;
}


export async function deleteRecipe(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM local_recipes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await db.runAsync('DELETE FROM local_recipes WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('recipe', localId, !!row?.server_id);
}