// migrateDietToLogFirst.js — Phase 8 one-time migration: old plan-scoped
// diet data → the log-first model. IDEMPOTENT and safe to re-run: every
// step is guarded by "already migrated?" checks, and the script logs
// before/after row counts. It NEVER deletes old data (old tables remain as
// read-only history); it only creates rows in the new model.
//
// What moves where:
//  1. backup_food_log_entries (prior Detailed-mode, plan-scoped diary —
//     the data genuinely represents what was eaten) → food_log_entries,
//     keeping local_entity_id so a re-run upserts in place instead of
//     duplicating. plan_ref/plan_version_id are DROPPED (no plan container
//     anymore); source vocabulary maps to the new food_source_type as
//     closely as it can ('planned'/'swapped'/'extra'/'free_logged' →
//     'manual' — the closest honest label for pre-migration entries).
//  2. diet_plans with daily targets → a user_nutrition_targets row per
//     client (source 'automatic' if client-authored, 'trainer_override'
//     if trainer-authored — the trainer DID set those numbers), set_by
//     matching. Guarded per user: skip if any target version already
//     exists for them.
//  3. diet_plan_meal_items (old plan structure) → structure_suggestions
//     rows (advisory text per meal slot, recipe pointer where it existed).
//     Guarded per plan: skip if suggestions already exist for that client.
//  4. diet_checkins (old Yes/No history) are NOT converted — you cannot
//     know what was actually eaten from a bare Yes/No. They stay as
//     read-only history (client shows them as "Before <migration date>").
//
// Run: cd backend && node scripts/migrateDietToLogFirst.js
require('dotenv').config();
const { query, pool } = require('../src/db/pool');
const nutritionLog = require('../src/data/nutritionLog');

const LEGACY_SOURCE_MAP = { planned: 'manual', swapped: 'manual', extra: 'manual', free_logged: 'manual' };
const MEAL_TYPE_MAP = {
  breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack',
  'pre-workout': 'other', 'post-workout': 'other',
};

async function migrateFoodLogs() {
  const { rows: before } = await query('SELECT COUNT(*)::int AS c FROM food_log_entries');
  const { rows: legacy } = await query(
    `SELECT * FROM backup_food_log_entries
     WHERE log_date IS NOT NULL AND name IS NOT NULL
     ORDER BY logged_at ASC`
  );
  let migrated = 0;
  for (const e of legacy) {
    // idempotency: same (user, local_entity_id) upserts in place
    const { rowCount } = await query(
      `INSERT INTO food_log_entries
         (user_id, local_entity_id, log_date, meal_type, name, calories, protein_g, carbs_g, fat_g,
          quantity, serving_unit, food_source_type, food_source_id, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (user_id, local_entity_id) DO NOTHING`,
      [e.user_id, e.local_entity_id, String(e.log_date).slice(0, 10),
       MEAL_TYPE_MAP[String(e.meal_type || '').toLowerCase()] || 'other',
       e.name, e.calories, e.protein_g, e.carbs_g, e.fat_g,
       e.quantity || 1, e.serving_size ? 'serving' : 'serving',
       LEGACY_SOURCE_MAP[e.source] || 'manual',
       e.food_source_id || null, e.logged_at || new Date().toISOString()]
    );
    migrated += rowCount || 0;
  }
  const { rows: after } = await query('SELECT COUNT(*)::int AS c FROM food_log_entries');
  console.log(`[migrate] food logs: legacy=${legacy.length} newly_inserted=${migrated} total_before=${before[0].c} total_after=${after[0].c}`);
}

async function migratePlanTargets() {
  const { rows: plans } = await query(
    `SELECT DISTINCT ON (p.client_id) p.*
     FROM diet_plans p
     WHERE p.status = 'active'
       AND (p.daily_calorie_target IS NOT NULL OR p.daily_protein_target IS NOT NULL
            OR p.daily_carbs_target IS NOT NULL OR p.daily_fat_target IS NOT NULL)
     ORDER BY p.client_id, p.created_at DESC`
  );
  let created = 0;
  for (const p of plans) {
    // idempotency: users who already have ANY target version are skipped
    const { rows: existing } = await query(
      'SELECT 1 FROM user_nutrition_targets WHERE user_id = $1 LIMIT 1',
      [p.client_id]
    );
    if (existing.length) continue;
    await query(
      `INSERT INTO user_nutrition_targets
         (user_id, version_number, effective_from, calories, protein_g, carbs_g, fat_g,
          target_source, set_by, override_note, created_by)
       VALUES ($1, 1, CURRENT_DATE, $2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.client_id, p.daily_calorie_target || 2000,
       p.daily_protein_target ?? 0, p.daily_carbs_target ?? 0, p.daily_fat_target ?? 0,
       p.created_by === 'trainer' ? 'trainer_override' : 'automatic',
       p.created_by === 'trainer' ? 'trainer' : 'self',
       p.created_by === 'trainer' ? 'Migrated from assigned plan targets' : null,
       p.trainer_id]
    );
    created++;
  }
  console.log(`[migrate] plan targets → target versions: plans_found=${plans.length} created=${created}`);
}

async function migratePlanStructure() {
  // old plan meal items become advisory suggestion text, preserving intent
  const { rows: plans } = await query(`SELECT id, client_id FROM diet_plans WHERE status = 'active'`);
  let created = 0;
  for (const p of plans) {
    const { rows: existing } = await query(
      'SELECT 1 FROM structure_suggestions WHERE user_id = $1 LIMIT 1',
      [p.client_id]
    );
    if (existing.length) continue;
    const { rows: items } = await query(
      `SELECT i.name, i.catalog_item_id, m.meal_type
       FROM diet_plan_meal_items i
       JOIN diet_plan_meals m ON m.id = i.diet_plan_meal_id
       JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
       WHERE d.diet_plan_id = $1
       ORDER BY d.order_index, m.order_index, i.order_index`,
      [p.id]
    );
    let i = 0;
    for (const it of items) {
      await query(
        `INSERT INTO structure_suggestions (user_id, meal_type, suggestion_text, suggested_recipe_id, order_index)
         VALUES ($1,$2,$3,$4,$5)`,
        [p.client_id,
         MEAL_TYPE_MAP[String(it.meal_type || '').toLowerCase()] || 'other',
         it.name,
         it.catalog_item_id || null,
         i++]
      );
      created++;
    }
  }
  console.log(`[migrate] plan structure → suggestions: plans_found=${plans.length} suggestions_created=${created}`);
}

async function main() {
  console.log('[migrate] log-first nutrition migration starting (idempotent — safe to re-run)');
  await nutritionLog.seedGlobalFoods().then((r) => console.log(`[migrate] global foods seeded: +${r.inserted} (seed set ${r.total})`));
  await migrateFoodLogs();
  await migratePlanTargets();
  await migratePlanStructure();
  console.log('[migrate] done. Old diet_plans/diet_checkins tables remain untouched as read-only history.');
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] FAILED:', e);
  process.exit(1);
});
