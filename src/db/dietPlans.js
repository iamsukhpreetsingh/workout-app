// Local-first data access for SELF-AUTHORED diet plans (client-owned).
// Every write is local SQLite + a queued backup upsert — creating, editing,
// deleting, and checking in on a diet plan all work fully offline. Objects
// returned by the read functions mirror the OLD API response shapes (with
// `id` aliased to local_id) so screens stay unchanged. Trainer-assigned
// plans are server-truth and never touch this module.
//
// ensureDietPlansLoaded() does a one-time pull from /user/backup/diet-plans
// (including plans migrated from the old server-first system by backend
// migration 025) so existing users see their plans immediately.
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { api } from '../lib/api';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';
import { todayLocalISO } from '../lib/checkinDates';

const parse = (v) => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};
const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const newLocalId = () => `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const MAX_MEAL_ITEM_ALTERNATIVES = 3;

// Same rules as the workout version (queries.js normalizeAlternatives) and
// the server-side check in backend/src/data/dietAlternatives.js: max 3,
// case-insensitive duplicates rejected — never silently truncated.
export function normalizeDietAlternatives(itemName, alternatives) {
  const out = [];
  for (const a of Array.isArray(alternatives) ? alternatives : []) {
    const name = String(a?.name ?? a ?? '').trim();
    if (!name) continue;
    if (out.length >= MAX_MEAL_ITEM_ALTERNATIVES) {
      throw new Error(`Up to ${MAX_MEAL_ITEM_ALTERNATIVES} alternatives per dish`);
    }
    const lower = name.toLowerCase();
    if (
      lower === String(itemName || '').trim().toLowerCase() ||
      out.some((x) => x.name.toLowerCase() === lower)
    ) {
      throw new Error(`"${name}" is already added as an alternative`);
    }
    out.push({
      name,
      calories: a?.calories ?? null,
      protein_g: a?.protein_g ?? null,
      carbs_g: a?.carbs_g ?? null,
      fat_g: a?.fat_g ?? null,
      recipe_local_id: a?.recipe_local_id ?? a?.catalog_item_id ?? null,
    });
  }
  return out;
}

// local plan ids are our generated 'dp_…' ids or migration-025 'mig_…' ids —
// never the UUIDs of trainer-assigned plans
export const isLocalDietPlanId = (id) =>
  typeof id === 'string' && (id.startsWith('dp_') || id.startsWith('mig_'));

const loadedUsers = new Set();

export async function ensureDietPlansLoaded() {
  const userId = getCurrentUserId();
  if (!userId || loadedUsers.has(userId)) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM local_diet_plans WHERE user_id = ?', [userId]);
  if (row.c > 0) {
    loadedUsers.add(userId);
    return;
  }
  try {
    const [plans, checkins] = await Promise.all([
      api('/user/backup/diet-plans'),
      api('/user/backup/diet-checkins').catch(() => []),
    ]);
    for (const p of plans || []) {
      await db.runAsync(
        `INSERT OR IGNORE INTO local_diet_plans
           (local_id, server_id, user_id, synced, name, notes, tags,
            daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
            tracking_mode, tolerance_pct, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [p.local_entity_id, p.id, userId, 1, p.name, p.notes ?? null, arr(p.tags),
         p.daily_calorie_target ?? null, p.daily_protein_target ?? null,
         p.daily_carbs_target ?? null, p.daily_fat_target ?? null,
         p.tracking_mode ?? 'simple', p.tolerance_pct ?? 10,
         Date.now(), Date.now()]
      );
      for (const d of p.days || []) {
        await db.runAsync(
          `INSERT OR IGNORE INTO local_diet_plan_days (local_id, diet_plan_local_id, day_label, order_index)
           VALUES (?,?,?,?)`,
          [d.local_entity_id, p.local_entity_id, d.day_label, d.order_index ?? 0]
        );
        for (const m of d.meals || []) {
          await db.runAsync(
            `INSERT OR IGNORE INTO local_diet_plan_meals (local_id, diet_day_local_id, meal_type, order_index, slot_note)
             VALUES (?,?,?,?,?)`,
            [m.local_entity_id, d.local_entity_id, m.meal_type, m.order_index ?? 0, m.slot_note ?? null]
          );
          for (const it of m.items || []) {
            await db.runAsync(
              `INSERT OR IGNORE INTO local_diet_plan_meal_items
                 (local_id, diet_meal_local_id, local_recipe_id, name, calories, protein_g, carbs_g, fat_g,
                  serving_size, recipe_url, quantity_multiplier, client_note, order_index, photo_path,
                  ingredients, allergens, prep_time_minutes, cook_time_minutes, difficulty,
                  alternate_servings, tags)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [it.local_entity_id, m.local_entity_id, it.local_recipe_id ?? null, it.name,
               it.calories ?? null, it.protein_g ?? null, it.carbs_g ?? null, it.fat_g ?? null,
               it.serving_size ?? null, it.recipe_url ?? null, it.quantity_multiplier ?? 1,
               it.client_note ?? null, it.order_index ?? 0, it.photo_path ?? null,
               arr(it.ingredients), arr(it.allergens), it.prep_time_minutes ?? null,
               it.cook_time_minutes ?? null, it.difficulty ?? null,
               JSON.stringify(it.alternate_servings || []), arr(it.tags)]
            );
            for (let ai = 0; ai < parse(it.alternatives).length; ai++) {
              const a = it.alternatives[ai];
              await db.runAsync(
                `INSERT INTO local_diet_plan_meal_item_alternatives
                   (local_diet_plan_meal_item_id, alternative_name, alternative_calories,
                    alternative_protein_g, alternative_carbs_g, alternative_fat_g,
                    alternative_recipe_local_id, order_index)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [it.local_entity_id, String(a?.name ?? '').trim(), a?.calories ?? null,
                 a?.protein_g ?? null, a?.carbs_g ?? null, a?.fat_g ?? null,
                 a?.recipe_local_id ?? null, ai]
              );
            }
          }
        }
      }
    }
    for (const c of checkins || []) {
      await db.runAsync(
        `INSERT INTO local_diet_checkins (user_id, diet_plan_local_id, date, followed, note, synced)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(diet_plan_local_id, date) DO UPDATE SET
           followed = excluded.followed, note = excluded.note, synced = 1`,
        [userId, c.diet_plan_local_id, c.date, c.followed ? 1 : 0, c.note ?? null]
      );
    }
    loadedUsers.add(userId);
  } catch {
    // offline — local view stands, retried next open
  }
}

function hydrateItem(it, alternatives = []) {
  return {
    id: it.local_id,
    local_id: it.local_id,
    catalog_item_id: it.local_recipe_id || null, // builder edit-prefill compatibility
    local_recipe_id: it.local_recipe_id || null,
    name: it.name,
    calories: it.calories, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g,
    serving_size: it.serving_size, recipe_url: it.recipe_url,
    quantity_multiplier: it.quantity_multiplier || 1,
    client_note: it.client_note || '',
    photo_path: it.photo_path || null,
    ingredients: parse(it.ingredients),
    allergens: parse(it.allergens),
    prep_time_minutes: it.prep_time_minutes, cook_time_minutes: it.cook_time_minutes,
    difficulty: it.difficulty,
    alternate_servings: parse(it.alternate_servings),
    tags: parse(it.tags),
    alternatives,
  };
}

async function attachItemAlternatives(db, itemLocalIds) {
  const map = new Map();
  for (const id of itemLocalIds) map.set(id, []);
  if (itemLocalIds.length === 0) return map;
  const rows = await db.getAllAsync(
    `SELECT * FROM local_diet_plan_meal_item_alternatives
     WHERE local_diet_plan_meal_item_id IN (${itemLocalIds.map(() => '?').join(',')})
     ORDER BY order_index`,
    itemLocalIds
  );
  for (const r of rows) {
    const list = map.get(r.local_diet_plan_meal_item_id);
    if (list) {
      list.push({
        name: r.alternative_name,
        calories: r.alternative_calories, protein_g: r.alternative_protein_g,
        carbs_g: r.alternative_carbs_g, fat_g: r.alternative_fat_g,
        recipe_local_id: r.alternative_recipe_local_id || null,
      });
    }
  }
  return map;
}

async function attachDays(db, plans) {
  for (const p of plans) {
    const days = await db.getAllAsync(
      'SELECT * FROM local_diet_plan_days WHERE diet_plan_local_id = ? ORDER BY order_index', [p.local_id]);
    for (const d of days) {
      const meals = await db.getAllAsync(
        'SELECT * FROM local_diet_plan_meals WHERE diet_day_local_id = ? ORDER BY order_index', [d.local_id]);
      for (const m of meals) {
        const items = await db.getAllAsync(
          'SELECT * FROM local_diet_plan_meal_items WHERE diet_meal_local_id = ? ORDER BY order_index', [m.local_id]);
        const altMap = await attachItemAlternatives(db, items.map((i) => i.local_id));
        m.items = items.map((it) => hydrateItem(it, altMap.get(it.local_id) || []));
        m.id = m.local_id;
        m.slot_note = m.slot_note || '';
      }
      d.meals = meals;
      d.id = d.local_id;
    }
    p.days = days;
    p.id = p.local_id;
    p.tags = parse(p.tags);
    p.tracking_mode = p.tracking_mode || 'simple';
    p.tolerance_pct = p.tolerance_pct != null ? p.tolerance_pct : 10;
    p.trainer_name = null; // self-authored by definition
    p.created_at = p.created_at ? new Date(p.created_at).toISOString() : new Date().toISOString();
    // backend semantics: diet list counts MEAL SLOTS
    p.item_count = days.reduce((n, d) => n + (d.meals || []).length, 0);
  }
  return plans;
}

export async function listLocalDietPlans() {
  await ensureDietPlansLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const plans = await db.getAllAsync(
    'SELECT * FROM local_diet_plans WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return attachDays(db, plans);
}

export async function getDietPlan(localId) {
  await ensureDietPlansLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  const plan = await db.getFirstAsync(
    'SELECT * FROM local_diet_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  if (!plan) return null;
  const [hydrated] = await attachDays(db, [plan]);
  return hydrated;
}

// payload shape: exactly what DietPlanBuilderScreen.save() builds today
// ({ name, notes, daily_*_target, days: [{ day_label, meals: [{ meal_type,
// slot_note, items: [...] }] }] }). catalog_item_id carries the recipe's
// local id in self mode.
export async function createDietPlan(payload) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const localId = newLocalId();
  const now = Date.now();
  await writePlanTree(db, userId, localId, payload, now);
  await openPlanVersion(db, localId, payload, 1);
  await enqueueUpsert('diet_plan', localId);
  return localId;
}

// ── plan versioning (§33): targets are snapshotted per effective_from date ─
// A diary entry must always be evaluated against the targets that were in
// force on ITS date, so editing targets never rewrites historical results.
function versionTargets(payload) {
  const p = payload || {};
  return {
    daily_calorie_target: p.daily_calorie_target ?? null,
    daily_protein_target: p.daily_protein_target ?? null,
    daily_carbs_target: p.daily_carbs_target ?? null,
    daily_fat_target: p.daily_fat_target ?? null,
    tolerance_pct: p.tolerance_pct ?? 10,
    tracking_mode: p.tracking_mode || 'simple',
  };
}

async function openPlanVersion(db, planLocalId, payload, versionNumber) {
  const t = versionTargets(payload);
  await db.runAsync(
    `INSERT OR REPLACE INTO local_diet_plan_versions
       (diet_plan_local_id, version_number, effective_from,
        daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
        tolerance_pct, tracking_mode, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [planLocalId, versionNumber, todayLocalISO(),
     t.daily_calorie_target, t.daily_protein_target, t.daily_carbs_target, t.daily_fat_target,
     t.tolerance_pct, t.tracking_mode, Date.now()]
  );
}

// The version effective on `dateStr` (latest effective_from <= date), falling
// back to the plan row itself when no versions exist (legacy plans).
export async function getPlanVersionForDate(planLocalId, dateStr) {
  const db = await getDb();
  const row = await db.getFirstAsync(
    `SELECT * FROM local_diet_plan_versions
     WHERE diet_plan_local_id = ? AND effective_from <= ?
     ORDER BY version_number DESC LIMIT 1`,
    [planLocalId, String(dateStr)]
  );
  return row || null;
}

export async function listDietPlanVersions(planLocalId) {
  const db = await getDb();
  return db.getAllAsync(
    `SELECT * FROM local_diet_plan_versions WHERE diet_plan_local_id = ?
     ORDER BY version_number ASC`,
    [planLocalId]
  );
}

// export async function updateDietPlan(localId, payload) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) return;
//   await deletePlanTree(db, localId);
//   await writePlanTree(db, userId, localId, payload, Date.now());
//   await db.runAsync('UPDATE local_diet_plans SET synced = 0, updated_at = ? WHERE local_id = ?', [Date.now(), localId]);
//   await enqueueUpsert('diet_plan', localId);
// }




export async function updateDietPlan(localId, payload) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  // capture created_at so an edit doesn't reset the plan's creation date,
  // and the previous targets so a target/tolerance/mode change can open a
  // new plan VERSION instead of rewriting history
  const existing = await db.getFirstAsync(
    `SELECT created_at, daily_calorie_target, daily_protein_target, daily_carbs_target,
            daily_fat_target, tolerance_pct, tracking_mode
     FROM local_diet_plans WHERE local_id = ? AND user_id = ?`,
    [localId, userId]
  );
  const createdAt = existing?.created_at || Date.now();
  // BUGFIX: the previous version deleted the plan's days/meals/items but
  // NOT the plan row itself — writePlanTree's INSERT then crashed with
  // "UNIQUE constraint failed: local_diet_plans.local_id" on every edit.
  // The plan row must be removed too before the tree is rewritten.
  await deletePlanTree(db, localId);
  await db.runAsync('DELETE FROM local_diet_plans WHERE local_id = ?', [localId]);
  await writePlanTree(db, userId, localId, payload, Date.now(), createdAt);
  await maybeOpenNewVersion(db, localId, existing, payload);
  await enqueueUpsert('diet_plan', localId);
}

// Targets/tolerance/tracking-mode UNCHANGED → nothing to do (structure-only
// edits keep the current version). CHANGED → a new version becomes effective
// from TODAY; every earlier diary date keeps evaluating against the old one.
async function maybeOpenNewVersion(db, localId, existing, payload) {
  const t = versionTargets(payload);
  const same =
    existing &&
    Number(existing.daily_calorie_target ?? -1) === Number(t.daily_calorie_target ?? -1) &&
    Number(existing.daily_protein_target ?? -1) === Number(t.daily_protein_target ?? -1) &&
    Number(existing.daily_carbs_target ?? -1) === Number(t.daily_carbs_target ?? -1) &&
    Number(existing.daily_fat_target ?? -1) === Number(t.daily_fat_target ?? -1) &&
    Number(existing.tolerance_pct ?? 10) === Number(t.tolerance_pct) &&
    (existing.tracking_mode || 'simple') === t.tracking_mode;
  if (same) return;
  const max = await db.getFirstAsync(
    'SELECT MAX(version_number) AS v FROM local_diet_plan_versions WHERE diet_plan_local_id = ?',
    [localId]
  );
  await openPlanVersion(db, localId, payload, (max?.v || 0) + 1);
}

// payload shape: exactly what DietPlanBuilderScreen.save() builds today
// ({ name, notes, daily_*_target, days: [{ day_label, meals: [{ meal_type,
// slot_note, items: [...] }] }] }). catalog_item_id carries the recipe's
// local id in self mode.
async function writePlanTree(db, userId, planLocalId, payload, now, createdAt) {
  const p = payload || {};
  await db.runAsync(
    `INSERT OR REPLACE INTO local_diet_plans
       (local_id, user_id, synced, name, notes, tags,
        daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
        tracking_mode, tolerance_pct, created_at, updated_at)
     VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?,?)`,
    [planLocalId, userId, String(p.name || 'Diet Plan').trim(), p.notes ?? null, arr(p.tags),
     p.daily_calorie_target ?? null, p.daily_protein_target ?? null,
     p.daily_carbs_target ?? null, p.daily_fat_target ?? null,
     p.tracking_mode || 'simple', p.tolerance_pct ?? 10, createdAt ?? now, now]
  );
  for (let di = 0; di < (p.days || []).length; di++) {
    const d = p.days[di] || {};
    const dayLocal = `${planLocalId}:d${di}`;
    await db.runAsync(
      `INSERT OR REPLACE INTO local_diet_plan_days (local_id, diet_plan_local_id, day_label, order_index)
       VALUES (?,?,?,?)`,
      [dayLocal, planLocalId, d.day_label || `Day ${di + 1}`, di]
    );
    for (let mi = 0; mi < (d.meals || []).length; mi++) {
      const m = d.meals[mi] || {};
      const mealLocal = `${dayLocal}:m${mi}`;
      await db.runAsync(
        `INSERT OR REPLACE INTO local_diet_plan_meals (local_id, diet_day_local_id, meal_type, order_index, slot_note)
         VALUES (?,?,?,?,?)`,
        [mealLocal, dayLocal, m.meal_type || 'Meal', mi, m.slot_note || null]
      );
      for (let ii = 0; ii < (m.items || []).length; ii++) {
        const it = m.items[ii] || {};
        await db.runAsync(
          `INSERT OR REPLACE INTO local_diet_plan_meal_items
             (local_id, diet_meal_local_id, local_recipe_id, name, calories, protein_g, carbs_g, fat_g,
              serving_size, recipe_url, quantity_multiplier, client_note, order_index, photo_path,
              ingredients, allergens, prep_time_minutes, cook_time_minutes, difficulty,
              alternate_servings, tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [`${mealLocal}:i${ii}`, mealLocal,
           it.catalog_item_id || it.local_recipe_id || null,
           String(it.name || 'Item').trim(),
           it.calories ?? null, it.protein_g ?? null, it.carbs_g ?? null, it.fat_g ?? null,
           it.serving_size ?? null, it.recipe_url ?? null, it.quantity_multiplier ?? 1,
           it.client_note || null, ii, it.photo_path ?? null,
           arr(it.ingredients), arr(it.allergens), it.prep_time_minutes ?? null,
           it.cook_time_minutes ?? null, it.difficulty ?? null,
           JSON.stringify(Array.isArray(it.alternate_servings) ? it.alternate_servings : []),
           arr(it.tags)]
        );
        // configured dish alternatives — snapshot macros at write time
        const alts = normalizeDietAlternatives(it.name, it.alternatives);
        for (let ai = 0; ai < alts.length; ai++) {
          const a = alts[ai];
          await db.runAsync(
            `INSERT INTO local_diet_plan_meal_item_alternatives
               (local_diet_plan_meal_item_id, alternative_name, alternative_calories,
                alternative_protein_g, alternative_carbs_g, alternative_fat_g,
                alternative_recipe_local_id, order_index)
             VALUES (?,?,?,?,?,?,?,?)`,
            [`${mealLocal}:i${ii}`, a.name, a.calories ?? null, a.protein_g ?? null,
             a.carbs_g ?? null, a.fat_g ?? null, a.recipe_local_id || null, ai]
          );
        }
      }
    }
  }
}



async function deletePlanTree(db, planLocalId) {
  await db.runAsync(
    `DELETE FROM local_diet_plan_meal_item_alternatives WHERE local_diet_plan_meal_item_id IN (
       SELECT i.local_id FROM local_diet_plan_meal_items i
       JOIN local_diet_plan_meals m ON i.diet_meal_local_id = m.local_id
       JOIN local_diet_plan_days d ON d.local_id = m.diet_day_local_id
       WHERE d.diet_plan_local_id = ?)`, [planLocalId]);
  await db.runAsync(
    `DELETE FROM local_diet_plan_meal_items WHERE diet_meal_local_id IN (
       SELECT m.local_id FROM local_diet_plan_meals m
       JOIN local_diet_plan_days d ON d.local_id = m.diet_day_local_id
       WHERE d.diet_plan_local_id = ?)`, [planLocalId]);
  await db.runAsync(
    `DELETE FROM local_diet_plan_meals WHERE diet_day_local_id IN (
       SELECT local_id FROM local_diet_plan_days WHERE diet_plan_local_id = ?)`, [planLocalId]);
  await db.runAsync('DELETE FROM local_diet_plan_days WHERE diet_plan_local_id = ?', [planLocalId]);
}

export async function deleteDietPlan(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM local_diet_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await deletePlanTree(db, localId);
  await db.runAsync('DELETE FROM local_diet_checkins WHERE diet_plan_local_id = ?', [localId]);
  // diary entries for the plan are historical records — the SERVER cleans up
  // its backup copies on the plan delete endpoint; locally they are removed
  // with the plan (the food-log rows were queued-upserts keyed to this plan)
  await db.runAsync('DELETE FROM local_food_log_entries WHERE plan_ref = ? AND user_id = ?', [localId, userId]);
  await db.runAsync('DELETE FROM local_diet_plan_versions WHERE diet_plan_local_id = ?', [localId]);
  await db.runAsync('DELETE FROM local_diet_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('diet_plan', localId, !!row?.server_id);
}

export async function checkInDiet(planLocalId, date, followed, note) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    `INSERT INTO local_diet_checkins (user_id, diet_plan_local_id, date, followed, note, synced)
     VALUES (?,?,?,?,?,0)
     ON CONFLICT(diet_plan_local_id, date) DO UPDATE SET
       followed = excluded.followed, note = excluded.note, synced = 0`,
    [userId, planLocalId, date, followed ? 1 : 0, note ?? null]
  );
  await enqueueUpsert('diet_checkin', `${planLocalId}|${date}`);
}

export async function listDietCheckins(planLocalId, limit = 30) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM local_diet_checkins WHERE diet_plan_local_id = ?
     ORDER BY date DESC LIMIT ?`, [planLocalId, limit]);
  return rows.map((c) => ({ date: c.date, followed: c.followed === 1, note: c.note }));
}