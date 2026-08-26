// Workout content oversight (ADMIN.md Phase 6): global exercises library,
// user custom-exercise duplicates, template browser, assignment detail,
// substitution audit, superset integrity, content health.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

function pagination(req, maxLimit = 200) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), maxLimit);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

// Whitelist of exercises-table columns an admin may edit (never id /
// created_at / updated_at). JSONB-typed entries are validated as objects.
const EXERCISE_EDITABLE = {
  name: 'text',
  category: 'text',
  body_part: 'text',
  equipment: 'text',
  muscle_group: 'text',
  secondary_muscles: 'jsonb',
  target: 'text',
  instructions: 'jsonb',
  instruction_steps: 'jsonb',
  image: 'text',
  gif_url: 'text',
  media_id: 'text',
  attribution: 'text',
  is_official: 'boolean',
};

// ════════════════════════ Global exercises library ═══════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/exercises', category: 'Workouts',
  description: 'Paginated browser of the global exercises library (migration 031). Search by name, filter body_part/equipment/category, sortable.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`e.name ILIKE $${params.length}`); }
    if (req.query.body_part) { params.push(req.query.body_part); where.push(`e.body_part = $${params.length}`); }
    if (req.query.equipment) { params.push(req.query.equipment); where.push(`e.equipment = $${params.length}`); }
    if (req.query.category) { params.push(req.query.category); where.push(`e.category = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCols = { name: 'e.name', body_part: 'e.body_part', equipment: 'e.equipment', category: 'e.category', created_at: 'e.created_at', updated_at: 'e.updated_at' };
    const sortCol = sortCols[req.query.sort] || 'e.name';
    const dir = String(req.query.order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const { limit, page, offset } = pagination(req);
    params.push(limit); const limitIdx = params.length;
    params.push(offset); const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT e.* FROM exercises e ${whereSql}
       ORDER BY ${sortCol} ${dir} NULLS LAST, e.id ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params);
    const total = (await query(
      `SELECT count(*)::int AS c FROM exercises e ${whereSql}`,
      params.slice(0, params.length - 2))).rows[0].c;
    res.json({ page, limit, total, exercises: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'PATCH', path: '/workout/exercises/:id', category: 'Workouts',
  description: 'Edit a global exercise (name/muscle_group/instructions/etc.) against the real columns of exercises — never id/created_at/updated_at. Audited.',
  allowedRoles: ['content_moderator', 'super_admin'],
}, async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [];
    for (const [field, type] of Object.entries(EXERCISE_EDITABLE)) {
      if (!(field in body)) continue;
      let value = body[field];
      if (type === 'jsonb' && value !== null && typeof value !== 'object') {
        return res.status(400).json({ error: `${field} must be an object/array (JSONB)` });
      }
      if (type === 'boolean') value = !!value;
      if (type === 'text' && value !== null && typeof value !== 'string') {
        return res.status(400).json({ error: `${field} must be a string or null` });
      }
      sets.push(`${field} = $${pushParam(params, value)}`);
    }
    if (!sets.length) return res.status(400).json({ error: `No editable fields supplied (allowed: ${Object.keys(EXERCISE_EDITABLE).join(', ')})` });
    params.push(req.params.id); const idIdx = params.length;
    sets.push(`updated_at = now()`);
    const before = await query('SELECT * FROM exercises WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Exercise not found' });
    const { rows } = await query(
      `UPDATE exercises SET ${sets.join(', ')} WHERE id = $${idIdx} RETURNING *`, params);
    await writeAudit(req.admin, 'exercise_update', 'exercises', req.params.id, before.rows[0], rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin'));

// ════════════════════════ User custom exercises ══════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/custom-exercises', category: 'Workouts',
  description: 'Platform-wide view of every user-created custom exercise (backup_custom_exercises) with owner info, plus lower(name)-normalized duplicate detection listing each duplicate cluster and its owners.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`ce.name ILIKE $${params.length}`); }
    if (req.query.muscle_group) { params.push(req.query.muscle_group); where.push(`ce.muscle_group = $${params.length}`); }
    if (req.query.user_id) { params.push(req.query.user_id); where.push(`ce.user_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { limit, page, offset } = pagination(req);
    params.push(limit); const limitIdx = params.length;
    params.push(offset); const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT ce.id, ce.user_id, u.name AS owner_name, u.email AS owner_email,
              ce.local_entity_id, ce.name, ce.muscle_group, ce.equipment, ce.body_part,
              ce.instructions, ce.thumbnail_path, ce.created_at, ce.updated_at
       FROM backup_custom_exercises ce JOIN users u ON u.id = ce.user_id
       ${whereSql}
       ORDER BY ce.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params);
    // duplicates are computed across the WHOLE table, independent of filters
    const dupRows = (await query(
      `SELECT lower(ce.name) AS normalized_name,
              count(*)::int AS occurrences,
              json_agg(json_build_object(
                'id', ce.id, 'user_id', ce.user_id,
                'owner_name', u.name, 'owner_email', u.email,
                'name', ce.name, 'muscle_group', ce.muscle_group,
                'created_at', ce.created_at) ORDER BY ce.created_at) AS owners
       FROM backup_custom_exercises ce JOIN users u ON u.id = ce.user_id
       GROUP BY lower(ce.name) HAVING count(*) > 1
       ORDER BY occurrences DESC, normalized_name ASC`)).rows;
    res.json({ page, limit, total: rows.length, exercises: rows, potential_duplicates: dupRows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════════ Template browser ═══════════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/templates', category: 'Workouts',
  description: 'Paginated workout-template browser with trainer name, exercise_count and reuse_count (assigned_plans whose source_template_id points here). Filters: trainer_id, tag, min_exercises, q.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const where = [];
    const having = [];
    const params = [];
    if (req.query.trainer_id) { params.push(req.query.trainer_id); where.push(`t.trainer_id = $${params.length}`); }
    if (req.query.tag) { params.push(req.query.tag); where.push(`$${params.length} = ANY(t.tags)`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`t.name ILIKE $${params.length}`); }
    if (req.query.min_exercises) {
      const idx = pushParam(params, parseInt(req.query.min_exercises, 10) || 0);
      having.push(`(SELECT count(*) FROM workout_template_exercises wte WHERE wte.workout_template_id = t.id) >= ${idx}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';
    const { limit, page, offset } = pagination(req);
    params.push(limit); const limitIdx = params.length;
    params.push(offset); const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT t.id, t.trainer_id, u.name AS trainer_name, u.email AS trainer_email,
              t.name, t.notes, t.tags, t.created_at, t.updated_at,
              (SELECT count(*)::int FROM workout_template_exercises wte
               WHERE wte.workout_template_id = t.id) AS exercise_count,
              (SELECT count(*)::int FROM assigned_plans p
               WHERE p.source_template_id = t.id) AS reuse_count
       FROM workout_templates t JOIN users u ON u.id = t.trainer_id
       ${whereSql}
       GROUP BY t.id, u.name, u.email
       ${havingSql}
       ORDER BY t.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params);
    res.json({ page, limit, total: rows.length, templates: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════════ Assignment detail ══════════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/assigned-plans/:id', category: 'Workouts',
  description: 'Full assignment detail: plan row, client/trainer names, per-exercise breakdown with configured alternatives, and template lineage via source_template_id.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.*, tr.name AS trainer_name, cl.name AS client_name, cl.email AS client_email
       FROM assigned_plans p
       LEFT JOIN users tr ON tr.id = p.trainer_id
       JOIN users cl ON cl.id = p.client_id
       WHERE p.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Assigned plan not found' });
    const plan = rows[0];
    plan.exercises = (await query(
      `SELECT ape.*, 
              json_agg(json_build_object('alternative_exercise_name', apa.alternative_exercise_name, 'order_index', apa.order_index)
                       ORDER BY apa.order_index) FILTER (WHERE apa.id IS NOT NULL) AS alternatives
       FROM assigned_plan_exercises ape
       LEFT JOIN assigned_plan_exercise_alternatives apa ON apa.assigned_plan_exercise_id = ape.id
       WHERE ape.assigned_plan_id = $1
       GROUP BY ape.id
       ORDER BY ape.order_index`, [req.params.id])).rows;
    // Lineage: assignments snapshot their template at assign-time and carry
    // source_template_id directly (migration 013). Templates themselves have
    // NO parent-template column, so the chain ends at this root template.
    plan.template_lineage = null;
    if (plan.source_template_id) {
      const tpl = (await query(
        `SELECT t.id, t.name, t.tags, u.name AS trainer_name, t.created_at,
                (SELECT count(*)::int FROM workout_template_exercises wte
                 WHERE wte.workout_template_id = t.id) AS exercise_count
         FROM workout_templates t JOIN users u ON u.id = t.trainer_id
         WHERE t.id = $1`, [plan.source_template_id])).rows[0] || null;
      if (tpl) plan.template_lineage = [{ ...tpl, depth_from_root: 0, note: 'root template (templates carry no parent-template linkage)' }];
    }
    res.json(plan);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════════ Substitutions audit ════════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/substitutions-audit', category: 'Workouts',
  description: 'Aggregated mid-session substitution pairs: session_exercise_details.original_exercise_name → exercise_name with counts, most frequent first.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const minCount = Math.max(parseInt(req.query.min_count, 10) || 1, 1);
    const { rows } = await query(
      `SELECT sed.original_exercise_name AS original,
              sed.exercise_name AS swapped_to,
              count(*)::int AS times_used,
              count(DISTINCT ss.client_id)::int AS distinct_clients,
              max(ss.performed_at) AS last_substituted_at
       FROM session_exercise_details sed
       JOIN session_summaries ss ON ss.id = sed.session_summary_id
       WHERE sed.original_exercise_name IS NOT NULL
         AND sed.original_exercise_name <> sed.exercise_name
       GROUP BY 1, 2
       HAVING count(*) >= $1
       ORDER BY times_used DESC, original ASC, swapped_to ASC`, [minCount]);
    const totals = (await query(
      `SELECT count(*)::int AS substitutions,
              count(DISTINCT sed.session_summary_id)::int AS affected_sessions,
              count(DISTINCT ss.client_id)::int AS clients_substituting
       FROM session_exercise_details sed
       JOIN session_summaries ss ON ss.id = sed.session_summary_id
       WHERE sed.original_exercise_name IS NOT NULL
         AND sed.original_exercise_name <> sed.exercise_name`)).rows[0];
    res.json({ totals, pairs: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════════ Superset integrity ═════════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/superset-integrity', category: 'Workouts',
  description: 'Orphaned superset halves: group_id-bearing exercise rows (templates + assigned plans) whose group has fewer than 2 members for their parent. Grouped by parent.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const templateOrphans = (await query(
      `SELECT t.id AS parent_id, 'template' AS parent_type, t.name AS parent_name,
              e.id AS exercise_row_id, e.exercise_name, e.order_index, e.group_id
       FROM workout_template_exercises e
       JOIN workout_templates t ON t.id = e.workout_template_id
       WHERE e.group_id IS NOT NULL AND (
         SELECT count(*) FROM workout_template_exercises x
         WHERE x.workout_template_id = e.workout_template_id AND x.group_id = e.group_id
       ) < 2
       ORDER BY t.name, e.order_index`)).rows;
    const planOrphans = (await query(
      `SELECT p.id AS parent_id, 'assigned_plan' AS parent_type, p.name AS parent_name,
              e.id AS exercise_row_id, e.exercise_name, e.order_index, e.group_id
       FROM assigned_plan_exercises e
       JOIN assigned_plans p ON p.id = e.assigned_plan_id
       WHERE e.group_id IS NOT NULL AND (
         SELECT count(*) FROM assigned_plan_exercises x
         WHERE x.assigned_plan_id = e.assigned_plan_id AND x.group_id = e.group_id
       ) < 2
       ORDER BY p.name, e.order_index`)).rows;
    const grouped = new Map();
    for (const r of [...templateOrphans, ...planOrphans]) {
      const key = `${r.parent_type}:${r.parent_id}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          parent_type: r.parent_type,
          parent_id: r.parent_id,
          parent_name: r.parent_name,
          orphaned_exercises: [],
        });
      }
      const g = grouped.get(key);
      g.orphaned_exercises.push({
        exercise_row_id: r.exercise_row_id,
        exercise_name: r.exercise_name,
        order_index: r.order_index,
        group_id: r.group_id,
      });
    }
    res.json({
      total_orphans: templateOrphans.length + planOrphans.length,
      parents_affected: grouped.size,
      groups: [...grouped.values()],
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════════ Content health ═════════════════════════════
registerRoute(router, {
  method: 'GET', path: '/workout/content-health', category: 'Workouts',
  description: 'Most/least-used workout templates by reuse_count (top 5 each) — dead-content detector.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const base = `SELECT t.id, t.name, u.name AS trainer_name, t.created_at,
                         (SELECT count(*)::int FROM assigned_plans p WHERE p.source_template_id = t.id) AS reuse_count
                  FROM workout_templates t JOIN users u ON u.id = t.trainer_id`;
    const mostUsed = (await query(`${base} ORDER BY reuse_count DESC, t.created_at ASC LIMIT 5`)).rows;
    const leastUsed = (await query(`${base} ORDER BY reuse_count ASC, t.created_at DESC LIMIT 5`)).rows;
    res.json({ most_used: mostUsed, least_used: leastUsed });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

module.exports = { router };
