// Data access for the trainer-owned meal catalog. All queries are scoped to
// the requesting trainer — one trainer's dishes are never visible to another.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FIELDS = ['name', 'description', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'serving_size', 'recipe_url', 'prep_notes'];

// richer optional metadata (migration 018) — every field nullable/empty-safe
function normalizeExtended(body, item) {
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  item.photo_path = body.photo_path || null;
  item.ingredients = strArr(body.ingredients);
  item.allergens = strArr(body.allergens);
  item.prep_time_minutes = body.prep_time_minutes != null && body.prep_time_minutes !== ''
    ? Math.max(0, Math.round(Number(body.prep_time_minutes))) : null;
  item.cook_time_minutes = body.cook_time_minutes != null && body.cook_time_minutes !== ''
    ? Math.max(0, Math.round(Number(body.cook_time_minutes))) : null;
  item.difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : null;
  item.suggested_meal_types = strArr(body.suggested_meal_types);
  item.is_favorite = !!body.is_favorite;
  // [{ label, calories, protein_g, carbs_g, fat_g }] — numeric-coerced, label required
  item.alternate_servings = (Array.isArray(body.alternate_servings) ? body.alternate_servings : [])
    .filter((a) => a && String(a.label || '').trim())
    .map((a) => ({
      label: String(a.label).trim(),
      calories: a.calories != null ? Math.round(Number(a.calories)) : null,
      protein_g: a.protein_g != null ? Number(a.protein_g) : null,
      carbs_g: a.carbs_g != null ? Number(a.carbs_g) : null,
      fat_g: a.fat_g != null ? Number(a.fat_g) : null,
    }));
}

const EXT_COLS = 'photo_path, ingredients, allergens, prep_time_minutes, cook_time_minutes, difficulty, suggested_meal_types, is_favorite, alternate_servings';
const EXT_PLACE = (start) => Array.from({ length: 9 }, (_, i) => `$${start + i}`).join(',');

function normalize(body) {
  const item = {};
  for (const f of FIELDS) {
    item[f] = body[f] === '' || body[f] === undefined ? null : body[f];
  }
  item.calories = item.calories != null ? Math.round(Number(item.calories)) : null;
  for (const m of ['protein_g', 'carbs_g', 'fat_g']) {
    item[m] = item[m] != null ? Number(item[m]) : null;
  }
  if (!item.name || !String(item.name).trim()) {
    throw new HttpError(400, 'Dish name is required');
  }
  item.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
  normalizeExtended(body, item);
  return item;
}

// case-insensitive duplicate guard with a clear message
async function assertNameFree(trainerId, name, excludeId = null) {
  const { rows } = await query(
    `SELECT name FROM meal_catalog_items
     WHERE trainer_id = $1 AND lower(name) = lower($2)
       AND ($3::uuid IS NULL OR id != $3)
     LIMIT 1`,
    [trainerId, name, excludeId]
  );
  if (rows.length) {
    throw new HttpError(409, `You already have a dish named "${rows[0].name}"`);
  }
}

// ── user-owned dishes ("My Dishes") ─────────────────────────────────────
// Same table, user_id set / trainer_id NULL. Snapshots keep existing plans
// stable when a user dish is later edited.

async function assertUserNameFree(userId, name, excludeId = null) {
  const { rows } = await query(
    `SELECT name FROM meal_catalog_items
     WHERE user_id = $1 AND lower(name) = lower($2)
       AND ($3::uuid IS NULL OR id != $3)
     LIMIT 1`,
    [userId, name, excludeId]
  );
  if (rows.length) {
    throw new HttpError(409, `You already have a dish named "${rows[0].name}"`);
  }
}

async function createUserDish(userId, body) {
  const item = normalize(body);
  await assertUserNameFree(userId, item.name);
  const { rows } = await query(
    `INSERT INTO meal_catalog_items
       (user_id, name, description, calories, protein_g, carbs_g, fat_g, serving_size, recipe_url, prep_notes, tags, ${EXT_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${EXT_PLACE(12)}) RETURNING *`,
    [userId, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags,
      item.photo_path, item.ingredients, item.allergens, item.prep_time_minutes, item.cook_time_minutes, item.difficulty, item.suggested_meal_types, item.is_favorite, JSON.stringify(item.alternate_servings)]
  );
  return rows[0];
}

async function listUserDishes(userId) {
  const { rows } = await query(
    'SELECT * FROM meal_catalog_items WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function updateUserDish(userId, id, body) {
  const item = normalize(body);
  await assertUserNameFree(userId, item.name, id);
  const { rows } = await query(
    `UPDATE meal_catalog_items SET
       name=$2, description=$3, calories=$4, protein_g=$5, carbs_g=$6, fat_g=$7,
       serving_size=$8, recipe_url=$9, prep_notes=$10, tags=$11,
       photo_path=$12, ingredients=$13, allergens=$14, prep_time_minutes=$15,
       cook_time_minutes=$16, difficulty=$17, suggested_meal_types=$18,
       is_favorite=$19, alternate_servings=$20
     WHERE id=$1 AND user_id=$21 RETURNING *`,
    [id, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags,
      item.photo_path, item.ingredients, item.allergens, item.prep_time_minutes, item.cook_time_minutes, item.difficulty, item.suggested_meal_types, item.is_favorite, JSON.stringify(item.alternate_servings), userId]
  );
  if (!rows.length) throw new HttpError(404, 'Dish not found');
  return rows[0];
}

async function removeUserDish(userId, id) {
  const { rowCount } = await query(
    'DELETE FROM meal_catalog_items WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  if (!rowCount) throw new HttpError(404, 'Dish not found');
}

async function create(trainerId, body) {
  const item = normalize(body);
  await assertNameFree(trainerId, item.name);
  try {
    const { rows } = await query(
      `INSERT INTO meal_catalog_items
         (trainer_id, name, description, calories, protein_g, carbs_g, fat_g, serving_size, recipe_url, prep_notes, tags, ${EXT_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${EXT_PLACE(12)}) RETURNING *`,
      [trainerId, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags,
        item.photo_path, item.ingredients, item.allergens, item.prep_time_minutes, item.cook_time_minutes, item.difficulty, item.suggested_meal_types, item.is_favorite, JSON.stringify(item.alternate_servings)]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'unique_dish_name_per_trainer') {
      throw new HttpError(400, 'A dish with this name already exists');
    }
    throw e;
  }
}

async function list(trainerId) {
  const { rows } = await query(
    'SELECT * FROM meal_catalog_items WHERE trainer_id = $1 ORDER BY created_at DESC',
    [trainerId]
  );
  return rows;
}

async function update(trainerId, id, body) {
  const item = normalize(body);
  await assertNameFree(trainerId, item.name, id); // allows keeping its own name

  const conflict = await query(
    `SELECT id FROM meal_catalog_items 
     WHERE trainer_id = $1 AND name = $2 AND id != $3`,
    [trainerId, item.name, id]
  );
  if (conflict.rows.length) {
    throw new HttpError(400, 'A dish with this name already exists');
  }

  const { rows } = await query(
    `UPDATE meal_catalog_items SET
       name=$2, description=$3, calories=$4, protein_g=$5, carbs_g=$6, fat_g=$7,
       serving_size=$8, recipe_url=$9, prep_notes=$10, tags=$11,
       photo_path=$12, ingredients=$13, allergens=$14, prep_time_minutes=$15,
       cook_time_minutes=$16, difficulty=$17, suggested_meal_types=$18,
       is_favorite=$19, alternate_servings=$20
     WHERE id=$1 AND trainer_id=$21 RETURNING *`,
    [id, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags,
      item.photo_path, item.ingredients, item.allergens, item.prep_time_minutes, item.cook_time_minutes, item.difficulty, item.suggested_meal_types, item.is_favorite, JSON.stringify(item.alternate_servings), trainerId]
  );
  if (!rows.length) throw new HttpError(404, 'Catalog item not found');
  // TAG CASCADE (unlike macros): editing a recipe's tags re-tags every plan
  // item that used it, across all clients — tags describe the recipe itself
  // (vegetarian, high-protein…), so keeping snapshots stale would mislabel
  // plans. Macros stay snapshotted (portion contracts with the client).
  await query(
    `UPDATE diet_plan_meal_items SET tags = $2 WHERE catalog_item_id = $1`,
    [id, item.tags]
  );
  return rows[0];
}

async function remove(trainerId, id) {
  // Deleting a catalog dish never affects plans that already used it —
  // plan items are snapshots. This only removes it from future selection.
  const { rowCount } = await query(
    'DELETE FROM meal_catalog_items WHERE id = $1 AND trainer_id = $2',
    [id, trainerId]
  );
  if (!rowCount) throw new HttpError(404, 'Catalog item not found');
}

module.exports = {
  create, list, update, remove,
  createUserDish, listUserDishes, updateUserDish, removeUserDish,
};
