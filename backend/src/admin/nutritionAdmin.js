// Nutrition content administration (ADMIN.md Phase 7). Sits alongside the
// generic browser (tableConfig already gives content_moderator read/write on
// meal_catalog_items); this module adds the views the generic table browser
// cannot express: joined-owner catalogs, FULL nested diet/supplement plan
// structures, the allergen vocabulary consistency check and the platform-wide
// tag vocabulary.
//
// SCHEMA NOTES (adapted to what actually exists):
//   • There is NO separate recipes table — migration 014 made
//     meal_catalog_items polymorphic-owned: exactly one of trainer_id /
//     user_id is set. "Personal recipes" = rows with user_id set.
//   • Allergens live in TWO places, both TEXT[] arrays:
//       meal_catalog_items.allergens      (migration 018)
//       client_intake_profiles.allergens  (migration 023)
//   • Diet hierarchy: diet_plans → diet_plan_days → diet_plan_meals →
//     diet_plan_meal_items (snapshots; migration 011/018), with configured
//     alternatives in diet_plan_meal_item_alternatives (migration 029) and
//     historical client swaps in diet_item_swaps (migration 029).
//   • Check-in adherence: diet_checkins.followed (BOOLEAN, migration 008),
//     supplement_checkins.taken (BOOLEAN, migrations 009/022).
//   • Tags: TEXT[] columns on workout_templates / assigned_plans / diet_plans
//     / supplement_plans / meal_catalog_items / diet_plan_meal_items, PLUS
//     the trainer_tags TABLE (name column, migration 020) — handled below.
//
// ACCESS NOTE: /nutrition/allergen-consistency returns actual client intake
// allergen VALUES, i.e. health data — restricted to support/super_admin,
// matching the Phase 8 intake-profile module's access rules rather than the
// looser "all admins can read" rule used elsewhere here.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

const READ_ROLES = ['content_moderator', 'support', 'super_admin', 'read_only', 'analyst'];

// ══════════════════════ Meal catalog browser (Phase 7) ════════════════
registerRoute(router, {
  method: 'GET', path: '/nutrition/meal-catalog', category: 'Nutrition',
  description: 'Platform-wide TRAINER-owned meal catalog browser (user-authored dishes live under /nutrition/recipes) joined with owner name/email. Filters: q (name search), trainer_id, allergen (array contains), tag.',
  allowedRoles: READ_ROLES,
}, async (req, res) => {
  try {
    const { q, trainer_id: trainerId, allergen, tag } = req.query;
    const where = ['m.trainer_id IS NOT NULL'];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`m.name ILIKE $${params.length}`); }
    if (trainerId) { params.push(trainerId); where.push(`m.trainer_id = $${params.length}`); }
    if (allergen) { params.push(allergen); where.push(`$${params.length} = ANY(m.allergens)`); }
    if (tag) { params.push(tag); where.push(`$${params.length} = ANY(m.tags)`); }
    const { rows } = await query(
      `SELECT m.id, m.name, m.description, m.calories, m.protein_g, m.carbs_g, m.fat_g,
              m.serving_size, m.tags, m.allergens, m.ingredients, m.difficulty,
              m.prep_time_minutes, m.cook_time_minutes, m.created_at,
              u.id AS trainer_id, u.name AS trainer_name, u.email AS trainer_email,
              (SELECT count(*)::int FROM diet_plan_meal_items mi WHERE mi.catalog_item_id = m.id) AS plan_usage_count
       FROM meal_catalog_items m JOIN users u ON u.id = m.trainer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole(...READ_ROLES));

// ═══════════════════ Personal recipes browser (Phase 7) ═══════════════
registerRoute(router, {
  method: 'GET', path: '/nutrition/recipes', category: 'Nutrition',
  description: 'Personal recipe catalog browser: USER-authored dishes (meal_catalog_items.user_id set per migration 014 — there is no separate recipes table) joined with the author account. Filters: q (name search), user_id, allergen (array contains), tag.',
  allowedRoles: READ_ROLES,
}, async (req, res) => {
  try {
    const { q, user_id: userId, allergen, tag } = req.query;
    const where = ['m.user_id IS NOT NULL'];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`m.name ILIKE $${params.length}`); }
    if (userId) { params.push(userId); where.push(`m.user_id = $${params.length}`); }
    if (allergen) { params.push(allergen); where.push(`$${params.length} = ANY(m.allergens)`); }
    if (tag) { params.push(tag); where.push(`$${params.length} = ANY(m.tags)`); }
    const { rows } = await query(
      `SELECT m.id, m.name, m.description, m.calories, m.protein_g, m.carbs_g, m.fat_g,
              m.serving_size, m.tags, m.allergens, m.ingredients, m.difficulty,
              m.prep_time_minutes, m.cook_time_minutes, m.created_at,
              u.id AS author_id, u.name AS author_name, u.email AS author_email, u.role AS author_role
       FROM meal_catalog_items m JOIN users u ON u.id = m.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole(...READ_ROLES));

// ═════════════════ Full nested diet plan detail (Phase 7) ═════════════
registerRoute(router, {
  method: 'GET', path: '/nutrition/diet-plans/:id', category: 'Nutrition',
  description: 'FULL diet plan structure: plan + days → meals → items (snapshot fields incl. allergens/tags), each item with its configured alternatives, recent client swaps (diet_item_swaps) and a 30-day followed yes/no check-in adherence summary.',
  allowedRoles: READ_ROLES,
}, async (req, res) => {
  try {
    const { id } = req.params;
    const plans = await query(
      `SELECT p.*, t.name AS trainer_name, t.email AS trainer_email,
              c.name AS client_name, c.email AS client_email
       FROM diet_plans p
       JOIN users t ON t.id = p.trainer_id
       JOIN users c ON c.id = p.client_id
       WHERE p.id = $1`, [id]);
    if (!plans.rows.length) return res.status(404).json({ error: 'Diet plan not found' });
    const plan = plans.rows[0];

    const days = (await query(
      'SELECT id, day_label, order_index FROM diet_plan_days WHERE diet_plan_id = $1 ORDER BY order_index', [id])).rows;

    // items first, alternatives aggregated in, then group items under meals
    const items = (await query(
      `SELECT mi.id, mi.diet_plan_meal_id, mi.catalog_item_id, mi.name, mi.calories,
              mi.protein_g, mi.carbs_g, mi.fat_g, mi.serving_size, mi.recipe_url,
              mi.quantity_multiplier, mi.client_note, mi.order_index,
              mi.allergens, mi.tags,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', a.id, 'alternative_name', a.alternative_name,
                          'alternative_calories', a.alternative_calories,
                          'alternative_protein_g', a.alternative_protein_g,
                          'alternative_carbs_g', a.alternative_carbs_g,
                          'alternative_fat_g', a.alternative_fat_g,
                          'alternative_catalog_item_id', a.alternative_catalog_item_id,
                          'order_index', a.order_index) ORDER BY a.order_index)
                   FROM diet_plan_meal_item_alternatives a
                  WHERE a.diet_plan_meal_item_id = mi.id), '[]') AS alternatives
       FROM diet_plan_meal_items mi
       JOIN diet_plan_meals m ON m.id = mi.diet_plan_meal_id
       JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
       WHERE d.diet_plan_id = $1
       ORDER BY m.order_index, mi.order_index`, [id])).rows;

    const meals = (await query(
      `SELECT m.id, m.diet_plan_day_id, m.meal_type, m.order_index, m.slot_note
       FROM diet_plan_meals m JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
       WHERE d.diet_plan_id = $1 ORDER BY d.order_index, m.order_index`, [id])).rows;

    const itemsByMeal = new Map();
    for (const it of items) {
      if (!itemsByMeal.has(it.diet_plan_meal_id)) itemsByMeal.set(it.diet_plan_meal_id, []);
      const { diet_plan_meal_id, ...rest } = it;
      itemsByMeal.get(it.diet_plan_meal_id).push(rest);
    }

    const adherence = (await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE followed)::int AS followed_yes,
              count(*) FILTER (WHERE NOT followed)::int AS followed_no
       FROM diet_checkins
       WHERE diet_plan_id = $1 AND date >= current_date - INTERVAL '30 days'`, [id])).rows[0];
    const lifetime = (await query(
      `SELECT count(*)::int AS total_checkins
       FROM diet_checkins WHERE diet_plan_id = $1`, [id])).rows[0];

    const swaps = (await query(
      `SELECT s.swap_date, s.original_name, s.swapped_name, s.swapped_calories,
              s.swapped_protein_g, s.swapped_carbs_g, s.swapped_fat_g, s.created_at
       FROM diet_item_swaps s
       WHERE s.plan_server_id = $1
       ORDER BY s.swap_date DESC LIMIT 50`, [id])).rows;

    const mealsByDayId = new Map();
    for (const m of meals) {
      if (!mealsByDayId.has(m.diet_plan_day_id)) mealsByDayId.set(m.diet_plan_day_id, []);
      mealsByDayId.get(m.diet_plan_day_id).push({
        id: m.id, meal_type: m.meal_type, order_index: m.order_index, slot_note: m.slot_note,
        items: itemsByMeal.get(m.id) || [],
      });
    }
    plan.days = days.map((d) => ({
      id: d.id, day_label: d.day_label, order_index: d.order_index,
      meals: mealsByDayId.get(d.id) || [],
    }));
    plan.checkin_summary_30d = adherence;
    plan.lifetime_checkins = lifetime.total_checkins;
    plan.recent_swaps = swaps;
    res.json(plan);
  } catch (e) { err(res, e); }
}, requireAdminRole(...READ_ROLES));

// ═══════════════ Full nested supplement plan detail (Phase 7) ═════════
registerRoute(router, {
  method: 'GET', path: '/nutrition/supplement-plans/:id', category: 'Nutrition',
  description: 'FULL supplement plan: plan + items (supplement/dosage/timing/notes) + trainer/client accounts + 30-day taken yes/no check-in adherence summary.',
  allowedRoles: READ_ROLES,
}, async (req, res) => {
  try {
    const { id } = req.params;
    const plans = await query(
      `SELECT p.*, t.name AS trainer_name, t.email AS trainer_email,
              c.name AS client_name, c.email AS client_email
       FROM supplement_plans p
       JOIN users t ON t.id = p.trainer_id
       JOIN users c ON c.id = p.client_id
       WHERE p.id = $1`, [id]);
    if (!plans.rows.length) return res.status(404).json({ error: 'Supplement plan not found' });
    const plan = plans.rows[0];
    plan.items = (await query(
      `SELECT id, supplement_name, dosage, timing, notes, order_index
       FROM supplement_plan_items WHERE supplement_plan_id = $1 ORDER BY order_index`, [id])).rows;
    plan.checkin_summary_30d = (await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE taken)::int AS taken_yes,
              count(*) FILTER (WHERE NOT taken)::int AS taken_no
       FROM supplement_checkins
       WHERE supplement_plan_id = $1 AND date >= current_date - INTERVAL '30 days'`, [id])).rows[0];
    plan.lifetime_checkins = (await query(
      'SELECT count(*)::int AS c FROM supplement_checkins WHERE supplement_plan_id = $1', [id])).rows[0].c;
    res.json(plan);
  } catch (e) { err(res, e); }
}, requireAdminRole(...READ_ROLES));

// ═════════════ Allergen vocabulary consistency check (Phase 7) ════════
// Both sources store free-form strings inside TEXT[] columns, but the app's
// conflict matching is an EXACT case-insensitive intersection (see
// src/lib/allergens.js) — any spelling/casing drift silently breaks warnings.
function normalizeAllergen(v) {
  return String(v).toLowerCase().trim();
}
function singularish(v) {
  const n = normalizeAllergen(v);
  return n.length > 3 && n.endsWith('s') ? n.slice(0, -1) : n;
}
function isNearDuplicate(a, b) {
  const na = normalizeAllergen(a);
  const nb = normalizeAllergen(b);
  if (na === nb) return true;                       // differs only by case/whitespace
  if (singularish(a) === singularish(b)) return true; // plural 's'
  if (na.includes(nb) || nb.includes(na)) return true; // substring, e.g. 'nuts' ⊂ 'tree nuts'
  return false;
}
function cluster(values) {
  // union-find over pairwise near-duplicate relations
  const parent = new Map(values.map((v) => [v, v]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (!isNearDuplicate(values[i], values[j])) continue;
      const ri = find(values[i]);
      const rj = find(values[j]);
      if (ri !== rj) parent.set(ri, rj);
    }
  }
  const groups = new Map();
  for (const v of values) {
    const root = find(v);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(v);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

registerRoute(router, {
  method: 'GET', path: '/nutrition/allergen-consistency', category: 'Nutrition',
  description: 'ALLERGEN VOCABULARY CONSISTENCY CHECK: distinct allergen values (with counts) from meal_catalog_items.allergens vs client_intake_profiles.allergens (both TEXT[]), values present in only ONE source (no case-insensitive cross-match, with near matches listed), and within-source near-duplicate clusters (case/plural/substring). Powers the admin warning UI — drift here silently breaks automatic allergen conflict matching. Returns client health data, hence the restricted roles.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const catalogRows = (await query(`
      SELECT allergen, count(*)::int AS count FROM (
        SELECT unnest(allergens) AS allergen FROM meal_catalog_items WHERE allergens <> '{}'
      ) x WHERE allergen <> '' GROUP BY allergen ORDER BY count DESC, allergen ASC`)).rows;
    const intakeRows = (await query(`
      SELECT allergen, count(*)::int AS count FROM (
        SELECT unnest(allergens) AS allergen FROM client_intake_profiles WHERE allergens <> '{}'
      ) y WHERE allergen <> '' GROUP BY allergen ORDER BY count DESC, allergen ASC`)).rows;

    const catalogValues = catalogRows.map((r) => r.allergen);
    const intakeValues = intakeRows.map((r) => r.allergen);

    const hasExactCi = (value, pool) =>
      pool.some((p) => normalizeAllergen(p) === normalizeAllergen(value));

    const unmatched = [];
    for (const r of catalogRows) {
      if (hasExactCi(r.allergen, intakeValues)) continue;
      unmatched.push({
        value: r.allergen,
        count: r.count,
        sources: ['meal_catalog_items'],
        nearMatches: intakeValues.filter((p) => isNearDuplicate(r.allergen, p)),
      });
    }
    for (const r of intakeRows) {
      if (hasExactCi(r.allergen, catalogValues)) continue;
      unmatched.push({
        value: r.allergen,
        count: r.count,
        sources: ['client_intake_profiles'],
        nearMatches: catalogValues.filter((p) => isNearDuplicate(r.allergen, p)),
      });
    }

    res.json({
      mealCatalogValues: catalogRows,
      intakeValues: intakeRows,
      unmatched,
      nearDuplicateClusters: [
        ...cluster(catalogValues).map((g) => ({ source_table: 'meal_catalog_items', values: g })),
        ...cluster(intakeValues).map((g) => ({ source_table: 'client_intake_profiles', values: g })),
      ],
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

// ═════════════════ Platform-wide tag vocabulary (Phase 7) ═════════════
registerRoute(router, {
  method: 'GET', path: '/nutrition/tag-vocabulary', category: 'Nutrition',
  description: 'Every distinct tag platform-wide with per-source usage counts. Sources: tags TEXT[] columns on meal_catalog_items / workout_templates / assigned_plans / diet_plans / supplement_plans / diet_plan_meal_items, PLUS the trainer_tags TABLE (its name column — a different storage model, noted here). Merge tooling for duplicates lives at POST /admin/content/tags/merge.',
  allowedRoles: READ_ROLES,
}, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT source_table, tag, sum(uses)::int AS usage_count FROM (
        SELECT 'workout_templates' AS source_table, tag, count(*)::int AS uses FROM (
          SELECT unnest(tags) AS tag FROM workout_templates) s GROUP BY tag
        UNION ALL
        SELECT 'assigned_plans', tag, count(*)::int FROM (
          SELECT unnest(tags) AS tag FROM assigned_plans) s GROUP BY tag
        UNION ALL
        SELECT 'diet_plans', tag, count(*)::int FROM (
          SELECT unnest(tags) AS tag FROM diet_plans) s GROUP BY tag
        UNION ALL
        SELECT 'supplement_plans', tag, count(*)::int FROM (
          SELECT unnest(tags) AS tag FROM supplement_plans) s GROUP BY tag
        UNION ALL
        SELECT 'meal_catalog_items', tag, count(*)::int FROM (
          SELECT unnest(tags) AS tag FROM meal_catalog_items) s GROUP BY tag
        UNION ALL
        SELECT 'diet_plan_meal_items', tag, count(*)::int FROM (
          SELECT unnest(tags) AS tag FROM diet_plan_meal_items) s GROUP BY tag
        UNION ALL
        SELECT 'trainer_tags', name AS tag, count(*)::int AS uses
          FROM trainer_tags GROUP BY name
      ) t GROUP BY source_table, tag
      ORDER BY usage_count DESC, source_table ASC, tag ASC`);
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole(...READ_ROLES));

module.exports = { router };
