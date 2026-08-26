// Shared validation + persistence for configured DISH alternatives on diet
// plan meal items — mirrors src/data/alternatives.js (the workout version),
// adapted to dishes/macros. Max 3 per meal item; an alternative may not
// duplicate the primary dish or another alternative on the same item
// (case-insensitive). Violations are rejected with 400 — never truncated.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_ALTERNATIVES = 3;

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// alternatives: [{ name | alternative_name, calories, protein_g, carbs_g,
//                  fat_g, catalog_item_id }]
// Returns cleaned [{ alternative_name, alternative_calories,
//   alternative_protein_g, alternative_carbs_g, alternative_fat_g,
//   alternative_catalog_item_id, order_index }].
// Macro values are treated as SNAPSHOTS supplied by the client at add time;
// catalog_item_id is stored reference-only and never joined for display —
// editing a catalog dish later must not change an existing alternative.
function normalizeDietItemAlternatives(itemName, alternatives) {
  if (alternatives == null) return [];
  if (!Array.isArray(alternatives)) {
    throw new HttpError(400, 'alternatives must be an array');
  }
  const out = [];
  const seen = new Set([norm(itemName)]);
  for (const raw of alternatives) {
    const name = String(raw?.name ?? raw?.alternative_name ?? '').trim();
    if (!name) continue;
    if (out.length >= MAX_ALTERNATIVES) {
      throw new HttpError(400, `Up to ${MAX_ALTERNATIVES} alternatives per dish`);
    }
    const key = norm(name);
    if (seen.has(key)) {
      throw new HttpError(
        400,
        key === norm(itemName)
          ? `'${name}' is the primary dish and cannot be its own alternative`
          : `'${name}' is already added as an alternative`
      );
    }
    seen.add(key);
    out.push({
      alternative_name: name,
      alternative_calories: numOrNull(raw?.calories),
      alternative_protein_g: numOrNull(raw?.protein_g),
      alternative_carbs_g: numOrNull(raw?.carbs_g),
      alternative_fat_g: numOrNull(raw?.fat_g),
      // catalog_item_id (trainer Meal Catalog) or recipe_local_id (personal
      // My Dishes / backup payload alias) — kept REFERENCE-ONLY
      alternative_catalog_item_id:
        raw?.catalog_item_id || raw?.alternative_catalog_item_id || raw?.recipe_local_id || null,
      order_index: out.length,
    });
  }
  return out;
}

async function insertForMealItem(client, mealItemId, alternatives) {
  for (const alt of alternatives) {
    await client.query(
      `INSERT INTO diet_plan_meal_item_alternatives
         (diet_plan_meal_item_id, alternative_name, alternative_calories,
          alternative_protein_g, alternative_carbs_g, alternative_fat_g,
          alternative_catalog_item_id, order_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [mealItemId, alt.alternative_name, alt.alternative_calories,
       alt.alternative_protein_g, alt.alternative_carbs_g, alt.alternative_fat_g,
       alt.alternative_catalog_item_id, alt.order_index]
    );
  }
}

// { [dietPlanMealItemId]: [alternative rows in order] }
async function fetchByMealItemIds(mealItemIds) {
  if (!mealItemIds.length) return {};
  const placeholders = mealItemIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT * FROM diet_plan_meal_item_alternatives
     WHERE diet_plan_meal_item_id IN (${placeholders}) ORDER BY order_index`,
    mealItemIds
  );
  const map = {};
  for (const r of rows) {
    (map[r.diet_plan_meal_item_id] = map[r.diet_plan_meal_item_id] || []).push(r);
  }
  return map;
}

module.exports = {
  normalizeDietItemAlternatives,
  insertForMealItem,
  fetchByMealItemIds,
  MAX_ALTERNATIVES,
};
