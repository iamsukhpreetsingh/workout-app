// nutritionLog.js — the LOG-FIRST nutrition data layer (migration 040).
//
// The daily food log is the core entity for EVERY user: entries are scoped
// to the logging user and a date, never to a plan. Targets/structure are
// overlays handled by nutritionTargetsService / structureSuggestions.
//
// Sections: global food database (seed + Open Food Facts caching) →
// three-layer food search → custom dishes (ingredient snapshots) →
// user-scoped food log entries (recent/frequent derivations).
const { query, transaction } = require('../db/pool');
const { FOOD_SEED } = require('./foodSeed');
const coaching = require('./coachingPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const SOURCES = ['global_database', 'personal_recipe', 'trainer_recipe', 'custom_dish', 'manual'];
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

// ── global food database ─────────────────────────────────────────────────

// Idempotent seed: inserts any seed row whose lower(name) isn't present yet.
// Safe to run repeatedly (npm run seed-foods) — existing rows are never
// touched, so admin edits/verifications survive re-seeding.
async function seedGlobalFoods() {
  let inserted = 0;
  for (const f of FOOD_SEED) {
    const { rowCount } = await query(
      `INSERT INTO global_foods
         (name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
          default_serving_size, default_serving_unit, source, verified, cuisine_tags)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'seed',true,$11
       WHERE NOT EXISTS (SELECT 1 FROM global_foods WHERE lower(name) = lower($1))`,
      [f.name, f.calories, f.protein_g, f.carbs_g, f.fat_g, f.fiber_g, f.sugar_g,
       f.sodium_mg, f.default_serving_size, f.default_serving_unit, f.cuisine_tags || []]
    );
    inserted += rowCount || 0;
  }
  return { inserted, total: FOOD_SEED.length };
}

// Unit-aware macro scaling. Seed values are per 100 g/ml; piece-based foods
// (unit 'piece'/'slice'/'clove' etc.) are per single unit. Spoons/cups/tbsp
// are stored as per-1-unit rows too (seed sets default_serving_size = 1).
const PER_PIECE_UNITS = new Set(['piece', 'slice', 'clove', 'scoop', 'bar', 'cup', 'tbsp', 'tsp', 'serving']);
function scaleFoodMacros(food, quantity = 1, unit) {
  const perPiece = PER_PIECE_UNITS.has(String(unit || food.default_serving_unit || 'serving').toLowerCase());
  const factor = perPiece ? Number(quantity) || 0 : (Number(quantity) || 0) / 100;
  const scale = (v) => (v == null ? null : Math.round(Number(v) * factor * 10) / 10);
  return {
    calories: food.calories != null ? Math.round(Number(food.calories) * factor) : null,
    protein_g: scale(food.protein_g),
    carbs_g: scale(food.carbs_g),
    fat_g: scale(food.fat_g),
    fiber_g: scale(food.fiber_g),
    sugar_g: scale(food.sugar_g),
    sodium_mg: scale(food.sodium_mg),
  };
}

async function cacheExternalFoods(items) {
  const cached = [];
  for (const f of items || []) {
    if (!f.name || f.calories == null) continue;
    const { rows } = await query(
      `INSERT INTO global_foods
         (name, brand, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
          default_serving_size, default_serving_unit, source, verified, barcode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'g','open_food_facts',false,$11)
       RETURNING *`,
      [String(f.name).slice(0, 200), f.brand || null, Math.round(f.calories),
       f.protein_g ?? null, f.carbs_g ?? null, f.fat_g ?? null,
       f.fiber_g ?? null, f.sugar_g ?? null, f.sodium_mg ?? null,
       f.barcode || null]
    );
    if (rows[0]) cached.push(rows[0]);
  }
  return cached;
}

// Open Food Facts lookup. Never throws — the seed DB + recipes remain fully
// usable when the external API is unreachable (offline-first principle).
async function openFoodFactsSearch(q) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}` +
        `&search_simple=1&action=process&json=1&page_size=5`,
      { signal: controller.signal, headers: { 'User-Agent': 'WorkoutTracker/1.0' } }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.products || [])
      .filter((p) => p.product_name && p.nutriments && p.nutriments['energy-kcal_100g'] != null)
      .map((p) => ({
        name: p.product_name,
        brand: p.brands || null,
        calories: Math.round(p.nutriments['energy-kcal_100g']),
        protein_g: p.nutriments.proteins_100g ?? null,
        carbs_g: p.nutriments.carbohydrates_100g ?? null,
        fat_g: p.nutriments.fat_100g ?? null,
        fiber_g: p.nutriments.fiber_100g ?? null,
        sugar_g: p.nutriments.sugars_100g ?? null,
        sodium_mg: p.nutriments.sodium_100g != null ? Math.round(p.nutriments.sodium_100g * 1000) : null,
        barcode: p.code || null,
      }));
  } catch {
    return [];
  }
}

async function openFoodFactsBarcode(barcode) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      { signal: controller.signal, headers: { 'User-Agent': 'WorkoutTracker/1.0' } }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.product;
    if (!p || !p.nutriments || p.nutriments['energy-kcal_100g'] == null) return null;
    return {
      name: p.product_name || 'Unknown product',
      brand: p.brands || null,
      calories: Math.round(p.nutriments['energy-kcal_100g']),
      protein_g: p.nutriments.proteins_100g ?? null,
      carbs_g: p.nutriments.carbohydrates_100g ?? null,
      fat_g: p.nutriments.fat_100g ?? null,
      fiber_g: p.nutriments.fiber_100g ?? null,
      sugar_g: p.nutriments.sugars_100g ?? null,
      sodium_mg: p.nutriments.sodium_100g != null ? Math.round(p.nutriments.sodium_100g * 1000) : null,
      barcode: String(barcode),
    };
  } catch {
    return null;
  }
}

// ── three-layer search (Phase 2) ─────────────────────────────────────────

async function searchFoods(userId, { q, barcode } = {}) {
  const results = [];

  if (barcode) {
    // barcode is exact-match: global DB first (incl. previously cached
    // OFF products), then a live OFF product lookup cached on success
    let { rows } = await query('SELECT * FROM global_foods WHERE barcode = $1 LIMIT 1', [String(barcode)]);
    if (!rows.length) {
      const found = await openFoodFactsBarcode(barcode);
      if (found) {
        const [cached] = await cacheExternalFoods([found]);
        rows = cached ? [cached] : [];
      }
    }
    return rows.map((f) => ({ ...f, layer: 'global_database', verified: f.verified }));
  }

  const term = String(q || '').trim();
  if (!term) {
    // empty query → most-used global foods as a browse list
    const { rows } = await query(
      `SELECT * FROM global_foods ORDER BY verified DESC, usage_count DESC, name LIMIT 30`
    );
    return rows.map((f) => ({ ...f, layer: 'global_database', verified: f.verified }));
  }

  // layer 1: global database (curated ranks above external results)
  const { rows: global } = await query(
    `SELECT * FROM global_foods
     WHERE name ILIKE '%' || $1 || '%' OR cuisine_tags @> ARRAY[lower($1)]
     ORDER BY verified DESC, usage_count DESC, name
     LIMIT 25`,
    [term]
  );
  results.push(...global.map((f) => ({ ...f, layer: 'global_database', verified: f.verified })));

  // layer 2: the user's personal recipes
  const { rows: personal } = await query(
    `SELECT id, local_entity_id, name, calories, protein_g, carbs_g, fat_g, serving_size
     FROM user_recipes WHERE user_id = $1 AND name ILIKE '%' || $2 || '%' LIMIT 10`,
    [userId, term]
  );
  results.push(...personal.map((r) => ({
    id: r.id, name: r.name, calories: r.calories, protein_g: r.protein_g,
    carbs_g: r.carbs_g, fat_g: r.fat_g, default_serving_size: 1,
    default_serving_unit: 'serving', layer: 'personal_recipe', verified: true,
    food_source_id: r.local_entity_id || String(r.id),
  })));

  // layer 3: the active trainer's catalog (inspirational, loggable content)
  const trainer = await coaching.getActiveTrainerForClient(userId).catch(() => null);
  if (trainer) {
    const { rows: trainerRows } = await query(
      `SELECT id, name, calories, protein_g, carbs_g, fat_g, serving_size
       FROM meal_catalog_items WHERE trainer_id = $1 AND name ILIKE '%' || $2 || '%' LIMIT 10`,
      [trainer.id, term]
    );
    results.push(...trainerRows.map((r) => ({
      id: r.id, name: r.name, calories: r.calories, protein_g: r.protein_g,
      carbs_g: r.carbs_g, fat_g: r.fat_g, default_serving_size: 1,
      default_serving_unit: 'serving', layer: 'trainer_recipe', verified: true,
      food_source_id: String(r.id),
    })));
  }

  // the user's own custom dishes (Phase 3) — logged by per-serving macros
  const { rows: dishes } = await query(
    `SELECT d.id, d.local_entity_id, d.name, d.total_servings,
            COALESCE(SUM(i.calories_snapshot), 0)  AS total_cal,
            COALESCE(SUM(i.protein_g_snapshot), 0) AS total_p,
            COALESCE(SUM(i.carbs_g_snapshot), 0)   AS total_c,
            COALESCE(SUM(i.fat_g_snapshot), 0)     AS total_f
     FROM custom_dishes d LEFT JOIN custom_dish_ingredients i ON i.custom_dish_id = d.id
     WHERE d.user_id = $1 AND d.name ILIKE '%' || $2 || '%'
     GROUP BY d.id LIMIT 10`,
    [userId, term]
  );
  results.push(...dishes.map((d) => ({
    id: d.id, name: d.name,
    calories: Math.round(Number(d.total_cal) / Number(d.total_servings || 1)),
    protein_g: Math.round((Number(d.total_p) / Number(d.total_servings || 1)) * 10) / 10,
    carbs_g: Math.round((Number(d.total_c) / Number(d.total_servings || 1)) * 10) / 10,
    fat_g: Math.round((Number(d.total_f) / Number(d.total_servings || 1)) * 10) / 10,
    default_serving_size: 1, default_serving_unit: 'serving',
    layer: 'custom_dish', verified: true, food_source_id: d.local_entity_id || String(d.id),
  })));

  // fall through to Open Food Facts when the seed DB looks thin, and CACHE
  // every real match so the same product never re-queries the external API
  if (term.length >= 3 && global.length < 5) {
    const external = await openFoodFactsSearch(term);
    const cached = await cacheExternalFoods(external);
    results.push(...cached.map((f) => ({ ...f, layer: 'global_database', verified: false, via_external: true })));
  }

  return results;
}

// ── custom dishes (Phase 3) ──────────────────────────────────────────────

async function upsertCustomDish(userId, payload) {
  const p = payload || {};
  if (!p.local_entity_id || !p.name) throw new HttpError(400, 'Dish requires local_entity_id and name');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO custom_dishes (user_id, local_entity_id, name, total_servings)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, total_servings = EXCLUDED.total_servings, updated_at = now()
       RETURNING id`,
      [userId, String(p.local_entity_id), String(p.name), Number(p.total_servings) || 1]
    );
    const dishId = rows[0].id;
    await client.query('DELETE FROM custom_dish_ingredients WHERE custom_dish_id = $1', [dishId]);
    let i = 0;
    for (const ing of p.ingredients || []) {
      if (!ing?.ingredient_name) continue;
      await client.query(
        `INSERT INTO custom_dish_ingredients
           (custom_dish_id, global_food_id, ingredient_name, quantity, unit,
            calories_snapshot, protein_g_snapshot, carbs_g_snapshot, fat_g_snapshot, order_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [dishId, ing.global_food_id || null, String(ing.ingredient_name),
         Number(ing.quantity) || 0, ing.unit || 'g',
         Number(ing.calories_snapshot) || 0, Number(ing.protein_g_snapshot) || 0,
         Number(ing.carbs_g_snapshot) || 0, Number(ing.fat_g_snapshot) || 0, i++]
      );
    }
    return getCustomDishByLocal(userId, String(p.local_entity_id));
  });
}

async function getCustomDishByLocal(userId, localId) {
  const { rows } = await query(
    `SELECT * FROM custom_dishes WHERE user_id = $1 AND local_entity_id = $2`,
    [userId, localId]
  );
  if (!rows[0]) return null;
  const { rows: ings } = await query(
    'SELECT * FROM custom_dish_ingredients WHERE custom_dish_id = $1 ORDER BY order_index',
    [rows[0].id]
  );
  return { ...rows[0], ingredients: ings };
}

async function listCustomDishes(userId) {
  const { rows } = await query(
    `SELECT * FROM custom_dishes WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  if (!rows.length) return [];
  const { rows: ings } = await query(
    `SELECT i.* FROM custom_dish_ingredients i
     JOIN custom_dishes d ON d.id = i.custom_dish_id
     WHERE d.user_id = $1 ORDER BY i.order_index`,
    [userId]
  );
  const byDish = new Map();
  for (const ing of ings) {
    if (!byDish.has(ing.custom_dish_id)) byDish.set(ing.custom_dish_id, []);
    byDish.get(ing.custom_dish_id).push(ing);
  }
  return rows.map((d) => ({ ...d, ingredients: byDish.get(d.id) || [] }));
}

async function deleteCustomDish(userId, localId) {
  await query('DELETE FROM custom_dishes WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

// ── user-scoped food log entries (Phase 1) ───────────────────────────────

async function upsertFoodLogEntries(userId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of list) {
    if (!e?.local_entity_id || !e.name || !e.log_date) {
      throw new HttpError(400, 'Each entry requires local_entity_id, name and log_date');
    }
    const mealType = MEAL_TYPES.includes(e.meal_type) ? e.meal_type : 'other';
    const sourceType = SOURCES.includes(e.food_source_type) ? e.food_source_type : 'manual';
    const { rows: r } = await query(
      `INSERT INTO food_log_entries
         (user_id, local_entity_id, log_date, meal_type, name, calories, protein_g, carbs_g, fat_g,
          fiber_g, sugar_g, sodium_mg, quantity, serving_unit, food_source_type, food_source_id,
          suggested_by_trainer, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         log_date = EXCLUDED.log_date, meal_type = EXCLUDED.meal_type, name = EXCLUDED.name,
         calories = EXCLUDED.calories, protein_g = EXCLUDED.protein_g, carbs_g = EXCLUDED.carbs_g,
         fat_g = EXCLUDED.fat_g, fiber_g = EXCLUDED.fiber_g, sugar_g = EXCLUDED.sugar_g,
         sodium_mg = EXCLUDED.sodium_mg, quantity = EXCLUDED.quantity,
         serving_unit = EXCLUDED.serving_unit, food_source_type = EXCLUDED.food_source_type,
         food_source_id = EXCLUDED.food_source_id,
         suggested_by_trainer = EXCLUDED.suggested_by_trainer,
         logged_at = EXCLUDED.logged_at, updated_at = now()
       RETURNING *`,
      [userId, String(e.local_entity_id), String(e.log_date).slice(0, 10), mealType, String(e.name),
       e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
       e.fiber_g ?? null, e.sugar_g ?? null, e.sodium_mg ?? null,
       e.quantity ?? 1, e.serving_unit || 'serving', sourceType,
       e.food_source_id != null ? String(e.food_source_id) : null,
       e.suggested_by_trainer === true,
       e.logged_at || nowIso()]
    );
    rows.push(r[0]);
    // organic database growth signal: count usage of matched global foods
    if (sourceType === 'global_database' && e.food_source_id) {
      await query('UPDATE global_foods SET usage_count = usage_count + 1 WHERE id = $1::uuid', [e.food_source_id]).catch(() => {});
    }
  }
  return rows;
}

async function listFoodLogEntries(userId, since) {
  const { rows } = await query(
    `SELECT * FROM food_log_entries WHERE user_id = $1
     ${since ? 'AND updated_at > $2' : ''}
     ORDER BY log_date ASC, logged_at ASC`,
    since ? [userId, since] : [userId]
  );
  return rows;
}

async function listFoodLogForDate(userId, date) {
  const { rows } = await query(
    `SELECT * FROM food_log_entries WHERE user_id = $1 AND log_date = $2::date ORDER BY logged_at ASC`,
    [userId, String(date).slice(0, 10)]
  );
  return rows;
}

async function deleteFoodLogEntry(userId, localId) {
  await query(
    'DELETE FROM food_log_entries WHERE user_id = $1 AND local_entity_id = $2',
    [userId, String(localId)]
  );
  return { ok: true };
}

// Recent (most recently logged, latest quantity per name) and Frequent
// (most-logged overall) — the low-friction re-logging surfaces (Phase 4).
async function recentAndFrequentFoods(userId, limit = 10) {
  const { rows: recent } = await query(
    `SELECT DISTINCT ON (lower(name)) name, calories, protein_g, carbs_g, fat_g,
            quantity, serving_unit, food_source_type, food_source_id, logged_at
     FROM food_log_entries WHERE user_id = $1
     ORDER BY lower(name), logged_at DESC`,
    [userId]
  );
  recent.sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));
  const { rows: frequent } = await query(
    `SELECT name, COUNT(*) AS times_logged, MAX(logged_at) AS last_at,
            AVG(calories) AS calories, AVG(protein_g) AS protein_g,
            AVG(carbs_g) AS carbs_g, AVG(fat_g) AS fat_g,
            MODE() WITHIN GROUP (ORDER BY serving_unit) AS serving_unit
     FROM food_log_entries WHERE user_id = $1
     GROUP BY lower(name), name
     ORDER BY times_logged DESC LIMIT $2`,
    [userId, limit]
  );
  return {
    recent: recent.slice(0, limit),
    frequent: frequent.map((f) => ({ ...f, calories: Math.round(Number(f.calories)), times_logged: Number(f.times_logged) })),
  };
}

module.exports = {
  MEAL_TYPES,
  seedGlobalFoods,
  scaleFoodMacros,
  searchFoods,
  upsertCustomDish,
  getCustomDishByLocal,
  listCustomDishes,
  deleteCustomDish,
  upsertFoodLogEntries,
  listFoodLogEntries,
  listFoodLogForDate,
  deleteFoodLogEntry,
  recentAndFrequentFoods,
};
