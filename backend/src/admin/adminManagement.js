// Admin Management section (isolated testing area) — global progression
// formula management, global exercise library management, and unified
// user-centric management. Mounted under /admin in server.js.
//
// Roles: reads → support/super_admin/read_only; writes → super_admin only.
// Every write is audited with before/after values. All user-data queries are
// explicitly scoped by user/client id — no cross-user leakage.
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

const READ_ROLES = ['support', 'super_admin', 'read_only'];
const WRITE_ROLES = ['super_admin'];

// ══════════════ SECTION 1 — Progression Formula Management ═════════════

const FORMULAS_FILE = path.resolve(__dirname, '..', 'data', 'progressionFormulas.json');

function loadFormulas() {
  // live read (same spirit as the API Explorer): a new formula added to the
  // shared JSON appears here immediately
  return JSON.parse(fs.readFileSync(FORMULAS_FILE, 'utf8'));
}

function findFormulaDef(key) {
  return loadFormulas().find((f) => f.key === key) || null;
}

// Validate admin-supplied params against the formula's paramSchema.
// Structured config only — admins can never inject expressions/code.
function validateParamsAgainstSchema(formula, params) {
  const schema = new Map((formula.paramSchema || []).map((p) => [p.key, p]));
  const clean = {};
  for (const [k, v] of Object.entries(params || {})) {
    const p = schema.get(k);
    if (!p) throw Object.assign(new Error(`Unknown parameter '${k}' for formula '${formula.key}'`), { status: 400 });
    if (p.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw Object.assign(new Error(`Parameter '${k}' must be a number`), { status: 400 });
      if (p.min != null && n < p.min) throw Object.assign(new Error(`Parameter '${k}' must be ≥ ${p.min}`), { status: 400 });
      if (p.max != null && n > p.max) throw Object.assign(new Error(`Parameter '${k}' must be ≤ ${p.max}`), { status: 400 });
      clean[k] = n;
    } else if (p.type === 'boolean') {
      clean[k] = Boolean(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

// GET /mgmt/formulas — every formula definition merged with its global
// override (if any). effectiveParams = what users WITHOUT explicit
// trainer/user settings will resolve to.
registerRoute(router, {
  method: 'GET', path: '/mgmt/formulas', category: 'Admin Management',
  description: 'All progression formulas with their global admin-set defaults and usage counts.',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const formulas = loadFormulas();
    const { rows: globals } = await query('SELECT * FROM progression_formula_globals');
    const byKey = new Map(globals.map((g) => [g.formula_key, g]));
    // usage: how many users resolve to each formula via their own setting
    const { rows: usage } = await query(
      `SELECT formula_key, count(*)::int AS users FROM user_progression_settings GROUP BY formula_key`
    );
    const useMap = new Map(usage.map((u) => [u.formula_key, u.users]));

    const out = [];
    for (const f of formulas) {
      const g = byKey.get(f.key);
      out.push({
        key: f.key,
        displayName: f.displayName,
        description: f.description,
        requiresTrainingMax: !!f.requiresTrainingMax,
        paramSchema: f.paramSchema || [],
        hasGlobalOverride: !!g,
        globalParams: g ? g.params : null,
        updatedAt: g ? g.updated_at : null,
        updatedBy: g ? g.updated_by : null,
        usersConfigured: useMap.get(f.key) || 0,
      });
    }
    res.json({ formulas: out });
  } catch (e) { err(res, e); }
});

registerRoute(router, {
  method: 'PUT', path: '/mgmt/formulas/:key/params', category: 'Admin Management',
  description: 'Sets GLOBAL default params for a formula. Applies to all users without an explicit trainer/user-specific override. Audited.',
  allowedRoles: ['super_admin'],
}, requireAdminRole(...WRITE_ROLES), async (req, res) => {
  try {
    const formula = findFormulaDef(req.params.key);
    if (!formula) return res.status(404).json({ error: 'Unknown formula key' });

    let before = null;
    const { rows: existing } = await query(
      'SELECT * FROM progression_formula_globals WHERE formula_key = $1', [req.params.key]);
    if (existing.length) before = existing[0];

    const clean = validateParamsAgainstSchema(formula, req.body?.params);

    const { rowCount } = await query(
      `INSERT INTO progression_formula_globals (formula_key, params, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (formula_key) DO UPDATE SET params = EXCLUDED.params, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.params.key, JSON.stringify(clean), req.admin.id]
    );
    await writeAudit(req.admin, 'global_formula_updated', 'progression_formula_globals', req.params.key,
      before ? { params: before.params } : null,
      { params: clean, scope: 'GLOBAL — affects all users without explicit overrides' });
    res.json({ ok: true, key: req.params.key, params: clean });
  } catch (e) { err(res, e); }
});

registerRoute(router, {
  method: 'DELETE', path: '/mgmt/formulas/:key/params', category: 'Admin Management',
  description: 'Removes the global override — formula falls back to its built-in schema defaults. Audited.',
  allowedRoles: ['super_admin'],
}, requireAdminRole(...WRITE_ROLES), async (req, res) => {
  try {
    const { rowCount, rows } = await query(
      'DELETE FROM progression_formula_globals WHERE formula_key = $1 RETURNING params', [req.params.key]);
    if (rowCount) {
      await writeAudit(req.admin, 'global_formula_reset', 'progression_formula_globals',
        req.params.key, { params: rows[0].params }, null);
    }
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

// GET /mgmt/formulas/:key/preview — uses the REAL resolution math: merges
// proposed params over current global/schema defaults exactly as the app
// would. Pure arithmetic on structured numbers — no expression execution.
registerRoute(router, {
  method: 'POST', path: '/mgmt/formulas/:key/preview', category: 'Admin Management',
  description: 'Preview of the effective params a plain user would get (schema defaults + current global override + proposed params) without saving.',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const formula = findFormulaDef(req.params.key);
    if (!formula) return res.status(404).json({ error: 'Unknown formula key' });
    const base = {};
    for (const p of formula.paramSchema || []) base[p.key] = p.default;
    const { rows } = await query('SELECT params FROM progression_formula_globals WHERE formula_key = $1', [req.params.key]);
    const effective = { ...base, ...((rows[0] && rows[0].params) || {}) };
    let proposal = req.body?.params;
    if (typeof proposal === 'string') {
      try { proposal = JSON.parse(proposal); } catch { proposal = {}; }
    }
    const proposed = validateParamsAgainstSchema(formula, proposal || {});
    res.json({ key: req.params.key, currentEffective: effective, proposedEffective: { ...effective, ...proposed } });
  } catch (e) { err(res, e); }
});

// ══════════════ SECTION 2 — Exercise Library Management ════════════════

const EXERCISE_FIELDS = ['name', 'category', 'body_part', 'equipment', 'muscle_group',
  'secondary_muscles', 'target', 'instructions', 'instruction_steps', 'image', 'gif_url', 'attribution'];
const EDITABLE_EXERCISE_FIELDS = EXERCISE_FIELDS.filter((f) => f !== 'name');

// GET /mgmt/exercises?archived=&q=&page=&pageSize=&sort=
registerRoute(router, {
  method: 'GET', path: '/mgmt/exercises', category: 'Admin Management',
  description: 'Paginated global exercise library with search; archived filter (default hides archived).',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const where = [];
    const params = [];
    const showArchived = req.query.archived === 'true' || req.query.archived === 'all';
    if (!showArchived) { params.push(false); where.push(`is_archived = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`name ILIKE $${params.length}`);
    }
    if (req.query.body_part) { params.push(req.query.body_part); where.push(`body_part = $${params.length}`); }
    if (req.query.equipment) { params.push(req.query.equipment); where.push(`equipment = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortWhitelist = ['name', 'body_part', 'equipment', 'created_at', 'updated_at'];
    const sort = sortWhitelist.includes(req.query.sort) ? req.query.sort : 'name';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

    const { rows: countRows } = await query(`SELECT count(*)::int AS c FROM exercises ${whereSql}`, params);
    const { rows } = await query(
      `SELECT id, name, category, body_part, equipment, muscle_group, target, image, gif_url,
              is_archived, archived_at, created_at, updated_at
       FROM exercises ${whereSql} ORDER BY "${sort}" ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ total: countRows[0].c, page, pageSize, exercises: rows });
  } catch (e) { err(res, e); }
});

// POST /mgmt/exercises — create a GLOBAL exercise (admin-only creation)
registerRoute(router, {
  method: 'POST', path: '/mgmt/exercises', category: 'Admin Management',
  description: 'Creates a global exercise visible to the whole platform. Duplicate names rejected (case/space-insensitive check). Audited.',
  allowedRoles: ['super_admin'],
}, requireAdminRole(...WRITE_ROLES), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return res.status(400).json({ error: 'Exercise name is required' });

    // duplicate protection: case/whitespace-normalized comparison
    const dup = await query(`SELECT id, name FROM exercises WHERE lower(name) = lower($1) AND NOT is_archived`, [name]);
    if (dup.rows.length) {
      return res.status(409).json({ error: `An exercise named "${dup.rows[0].name}" already exists` });
    }

    const fields = { name };
    for (const f of EDITABLE_EXERCISE_FIELDS) {
      if (b[f] !== undefined) fields[f] = b[f];
      if (f === 'secondary_muscles' && b[f] !== undefined && !Array.isArray(b[f])) {
        return res.status(400).json({ error: 'secondary_muscles must be an array' });
      }
      if ((f === 'instructions' || f === 'instruction_steps') && b[f] !== undefined && typeof b[f] !== 'object') {
        return res.status(400).json({ error: `${f} must be an object` });
      }
    }
    // the library's TEXT pk has no default — mint a uuid for admin-created rows
    fields.id = crypto.randomUUID();
    const keys = Object.keys(fields);
    const { rows } = await query(
      `INSERT INTO exercises (${keys.map((k) => `"${k}"`).join(',')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]))
    );
    await writeAudit(req.admin, 'global_exercise_created', 'exercises', rows[0].id, null, { name });
    res.status(201).json(rows[0]);
  } catch (e) { err(res, e); }
});

// PATCH /mgmt/exercises/:id — edit global exercise metadata
registerRoute(router, {
  method: 'PATCH', path: '/mgmt/exercises/:id', category: 'Admin Management',
  description: 'Edits a global exercise (metadata only; id/name immutable so history keeps resolving). Audited.',
  allowedRoles: ['super_admin'],
}, requireAdminRole(...WRITE_ROLES), async (req, res) => {
  try {
    const { rows: beforeRows } = await query('SELECT * FROM exercises WHERE id::text = $1', [req.params.id]);
    if (!beforeRows.length) return res.status(404).json({ error: 'Exercise not found' });

    const sets = [];
    const params = [];
    for (const f of EDITABLE_EXERCISE_FIELDS) {
      if (req.body?.[f] === undefined) continue;
      if ((f === 'instructions' || f === 'instruction_steps') && typeof req.body[f] !== 'object') {
        return res.status(400).json({ error: `${f} must be an object` });
      }
      if (f === 'secondary_muscles' && !Array.isArray(req.body[f])) {
        return res.status(400).json({ error: 'secondary_muscles must be an array' });
      }
      params.push(typeof req.body[f] === 'object' && req.body[f] !== null ? JSON.stringify(req.body[f]) : req.body[f]);
      sets.push(`"${f}" = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
    sets.push(`updated_at = now()`);
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE exercises SET ${sets.join(', ')} WHERE id::text = $${params.length} RETURNING *`, params);
    await writeAudit(req.admin, 'global_exercise_updated', 'exercises', req.params.id,
      { name: beforeRows[0].name }, { fields: Object.keys(req.body || {}) });
    res.json(rows[0]);
  } catch (e) { err(res, e); }
});

// GET /mgmt/exercises/:id/usage — reference counts shown BEFORE archive
registerRoute(router, {
  method: 'GET', path: '/mgmt/exercises/:id/usage', category: 'Admin Management',
  description: 'How widely a global exercise is referenced (templates, assigned plans, historical sessions by name).',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const { rows: ex } = await query('SELECT id, name FROM exercises WHERE id::text = $1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'Exercise not found' });
    const name = ex[0].name;
    // references are NAME-based throughout this app (portable key across devices)
    const byName = async (table) =>
      (await query(`SELECT count(*)::int c FROM ${table} WHERE exercise_name = $1`, [name])).rows[0].c;
    res.json({
      exercise: ex[0],
      usage: {
        workout_templates: await byName('workout_template_exercises'),
        assigned_plans: await byName('assigned_plan_exercises'),
        historical_session_records: await byName('session_exercise_details'),
        note: 'references resolve by exercise name; archiving preserves all history',
      },
    });
  } catch (e) { err(res, e); }
});

// DELETE /mgmt/exercises/:id — SOFT ARCHIVE only; never a hard delete
registerRoute(router, {
  method: 'DELETE', path: '/mgmt/exercises/:id', category: 'Admin Management',
  description: 'Archives a global exercise (soft delete). Historical records preserved; hidden from new selection. Audited.',
  allowedRoles: ['super_admin'],
}, requireAdminRole(...WRITE_ROLES), async (req, res) => {
  try {
    const restore = req.query.restore === 'true';
    const { rows: beforeRows } = await query('SELECT id, name, is_archived FROM exercises WHERE id::text = $1', [req.params.id]);
    if (!beforeRows.length) return res.status(404).json({ error: 'Exercise not found' });

    const { rows } = await query(
      `UPDATE exercises SET is_archived = $1, archived_at = $2, updated_at = now()
       WHERE id::text = $3 RETURNING id, name, is_archived`,
      [!restore, !restore ? new Date().toISOString() : null, req.params.id]
    );
    await writeAudit(req.admin, restore ? 'global_exercise_restored' : 'global_exercise_archived',
      'exercises', req.params.id, { name: beforeRows[0].name, is_archived: beforeRows[0].is_archived },
      { is_archived: rows[0].is_archived, note: 'soft archive — historical data untouched' });
    res.json(rows[0]);
  } catch (e) { err(res, e); }
});

// ══════════════ SECTION 3 — Unified User Management ════════════════════

async function assertUserExists(id) {
  const { rows } = await query('SELECT id FROM users WHERE id::text = $1', [String(id)]);
  if (!rows.length) throw Object.assign(new Error('User not found'), { status: 404 });
}

// GET /mgmt/users?q=&status=&sort=&dir=&page=&pageSize=
registerRoute(router, {
  method: 'GET', path: '/mgmt/users', category: 'Admin Management',
  description: 'Server-side searchable/filterable/paginated user list (search by id, name, email).',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const where = [];
    const params = [];
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.id::text ILIKE $${params.length})`);
    }
    if (req.query.status === 'suspended') where.push(`u.is_suspended = TRUE`);
    if (req.query.status === 'active') where.push(`u.is_suspended = FALSE`);
    if (req.query.role) { params.push(req.query.role); where.push(`u.role = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortMap = { name: 'u.name', email: 'u.email', created: 'u.created_at', updated: 'u.updated_at' };
    const sortCol = sortMap[req.query.sort] || 'u.created_at';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const { rows: countRows } = await query(`SELECT count(*)::int c FROM users u ${whereSql}`, params);
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_suspended, u.created_at
       FROM users u ${whereSql} ORDER BY ${sortCol} ${dir} NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ total: countRows[0].c, page, pageSize, users: rows });
  } catch (e) { err(res, e); }
});

// GET /mgmt/users/:id/overview — one-shot summary across ALL domains
registerRoute(router, {
  method: 'GET', path: '/mgmt/users/:id/overview', category: 'Admin Management',
  description: 'Unified per-user overview: profile plus counts across workouts, custom exercises, diets, dishes, recipes, supplements, checkins, progression.',
  allowedRoles: ['support+ read'],
}, requireAdminRole(...READ_ROLES), async (req, res) => {
  try {
    const uid = String(req.params.id);
    await assertUserExists(uid);
    const one = async (sql) => (await query(sql, [uid])).rows[0] || {};
    const profile = (await query(
      `SELECT id, name, email, role, is_suspended, created_at, updated_at AS last_active FROM users WHERE id::text = $1`, [uid])).rows[0];
    const [
      workouts, customExercises, dietPlans, supplementPlans, dishes, recipes,
      dietCheckins, supplementCheckins, measurements, progressionSettings,
    ] = await Promise.all([
      one(`SELECT count(*)::int c FROM session_summaries WHERE client_id::text = $1`),
      one(`SELECT count(*)::int c FROM backup_custom_exercises WHERE user_id::text = $1`),
      one(`SELECT count(*)::int c FROM diet_plans WHERE client_id::text = $1`),
      one(`SELECT count(*)::int c FROM supplement_plans WHERE client_id::text = $1`),
      one(`SELECT count(*)::int c FROM meal_catalog_items WHERE user_id::text = $1`),
      one(`SELECT count(*)::int c FROM user_recipes WHERE user_id::text = $1`),
      one(`SELECT count(*)::int c FROM diet_checkins dc JOIN diet_plans dp ON dp.id = dc.diet_plan_id WHERE dp.client_id::text = $1`),
      one(`SELECT count(*)::int c FROM supplement_checkins sc JOIN supplement_plans sp ON sp.id = sc.supplement_plan_id WHERE sp.client_id::text = $1`),
      one(`SELECT count(*)::int c FROM measurement_entries WHERE client_id::text = $1`),
      one(`SELECT count(*)::int c FROM user_progression_settings WHERE user_id::text = $1`),
    ]);
    const activeTrainer = (await query(
      `SELECT u.id, u.name FROM trainer_clients tc JOIN users u ON u.id = tc.trainer_id
       WHERE tc.client_id::text = $1 AND tc.status = 'active' LIMIT 1`, [uid])).rows[0] || null;
    res.json({
      profile, activeTrainer,
      counts: {
        workouts: workouts.c, customExercises: customExercises.c, dietPlans: dietPlans.c,
        supplementPlans: supplementPlans.c, dishes: dishes.c, recipes: recipes.c,
        dietCheckins: dietCheckins.c, supplementCheckins: supplementCheckins.c,
        measurements: measurements.c, progressionSettings: progressionSettings.c,
      },
    });
  } catch (e) { err(res, e); }
});

// paginated per-domain listing helper — every query hard-scoped to the user
function userListEndpoint(pathSuffix, description, sqlWithPage) {
  registerRoute(router, {
    method: 'GET', path: `/mgmt/users/:id/${pathSuffix}`, category: 'Admin Management',
    description, allowedRoles: ['support+ read'],
  }, requireAdminRole(...READ_ROLES), async (req, res) => {
    try {
      const uid = String(req.params.id);
      await assertUserExists(uid);
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
      const { list, count, params } = sqlWithPage(uid, req.query, page, pageSize);
      const listResult = await query(list, [...params, pageSize, (page - 1) * pageSize]);
      const countResult = await query(count, params);
      res.json({ total: countResult.rows[0].c, page, pageSize, items: listResult.rows });
    } catch (e) { err(res, e); }
  });
}

userListEndpoint('workouts', 'Selected user\'s workout sessions (scoped strictly to this user).', (uid) => ({
  params: [uid],
  list: `SELECT id, name, performed_at, duration_seconds, total_volume
         FROM session_summaries WHERE client_id::text = $1 ORDER BY performed_at DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM session_summaries WHERE client_id::text = $1`,
}));

userListEndpoint('custom-exercises', 'Custom exercises created by this user.', (uid) => ({
  params: [uid],
  list: `SELECT id, name, muscle_group, instructions, thumbnail_path, created_at
         FROM backup_custom_exercises WHERE user_id::text = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM backup_custom_exercises WHERE user_id::text = $1`,
}));

userListEndpoint('diets', 'Diet plans assigned to or created by this user.', (uid) => ({
  params: [uid],
  list: `SELECT id, name, status, daily_calorie_target, daily_protein_target, created_at
         FROM diet_plans WHERE client_id::text = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM diet_plans WHERE client_id::text = $1`,
}));

userListEndpoint('dishes', 'Dish catalog entries owned by this user.', (uid) => ({
  params: [uid],
  list: `SELECT id, name, calories, protein_g, carbs_g, fat_g, serving_size, created_at
         FROM meal_catalog_items WHERE user_id::text = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM meal_catalog_items WHERE user_id::text = $1`,
}));

userListEndpoint('recipes', 'Personal recipes authored by this user.', (uid) => ({
  params: [uid],
  list: `SELECT * FROM user_recipes WHERE user_id::text = $1 ORDER BY name LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM user_recipes WHERE user_id::text = $1`,
}));

userListEndpoint('supplements', 'Supplement plans for this user.', (uid) => ({
  params: [uid],
  list: `SELECT id, name, status, notes, created_at
         FROM supplement_plans WHERE client_id::text = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(*)::int c FROM supplement_plans WHERE client_id::text = $1`,
}));

userListEndpoint('nutrition', 'This user\'s diet & supplement check-in history (nutrition logs).', (uid) => ({
  params: [uid],
  list: `SELECT 'diet' AS kind, dc.date, dc.followed, dc.note, NULL AS plan_name
           FROM diet_checkins dc WHERE dc.client_id::text = $1
         UNION ALL
         SELECT 'supplement' AS kind, sc.date, sc.taken AS followed, sc.note, NULL AS plan_name
           FROM supplement_checkins sc WHERE sc.client_id::text = $1
         ORDER BY date DESC LIMIT $2 OFFSET $3`,
  count: `SELECT
            (SELECT count(*)::int FROM diet_checkins WHERE client_id::text = $1)
          + (SELECT count(*)::int FROM supplement_checkins WHERE client_id::text = $1)
          AS c`,
}));

userListEndpoint('progression', 'Progression settings, trainer overrides and recent strength records for this user.', (uid) => ({
  params: [uid],
  list: `SELECT 'setting' AS kind, formula_key, params::text AS detail, updated_at AS date, NULL AS note
           FROM user_progression_settings WHERE user_id::text = $1
         UNION ALL
         SELECT 'trainer_override' AS kind, o.formula_key, o.params::text, o.updated_at AS date, tu.name AS note
           FROM trainer_client_progression_overrides o
           JOIN users tu ON tu.id = o.trainer_id
          WHERE o.client_id::text = $1
         ORDER BY date DESC LIMIT $2 OFFSET $3`,
  count: `SELECT
            (SELECT count(*)::int FROM user_progression_settings WHERE user_id::text = $1)
          + (SELECT count(*)::int FROM trainer_client_progression_overrides WHERE client_id::text = $1) AS c`,
}));

userListEndpoint('analytics', 'Per-user analytics: measurement trends and training volume by week.', (uid) => ({
  params: [uid],
  list: `SELECT date_trunc('week', s.performed_at)::date AS week,
                count(*)::int AS sessions,
                coalesce(sum(s.total_volume), 0)::numeric(12,1) AS volume
           FROM session_summaries s WHERE s.client_id::text = $1
         GROUP BY week ORDER BY week DESC LIMIT $2 OFFSET $3`,
  count: `SELECT count(DISTINCT date_trunc('week', performed_at))::int c FROM session_summaries WHERE client_id::text = $1`,
}));

module.exports = { router };
