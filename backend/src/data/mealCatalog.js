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

async function create(trainerId, body) {
  const item = normalize(body);
  await assertNameFree(trainerId, item.name);
  try {
    const { rows } = await query(
      `INSERT INTO meal_catalog_items
         (trainer_id, name, description, calories, protein_g, carbs_g, fat_g, serving_size, recipe_url, prep_notes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [trainerId, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags]
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
       serving_size=$8, recipe_url=$9, prep_notes=$10, tags=$11
     WHERE id=$1 AND trainer_id=$12 RETURNING *`,
    [id, item.name, item.description, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size, item.recipe_url, item.prep_notes, item.tags, trainerId]
  );
  if (!rows.length) throw new HttpError(404, 'Catalog item not found');
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

module.exports = { create, list, update, remove };
