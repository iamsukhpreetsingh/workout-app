// Progression-engine oversight (ADMIN.md Phase 9). Read-only view of the
// shared progressionFormulas.json config (re-read from disk on every call so
// new formulas appear immediately), platform-wide formula-usage breakdown,
// and a browser/cleaner for stuck trainer_client_progression_overrides.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');

const router = express.Router();
router.use(requireAdmin());
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

// Same file src/data/progression.js loads (it lives in backend/src/data —
// NOT the mobile folder), resolved absolutely off __dirname so the live
// on-disk copy is always what we serve, never a cached require().
function formulasPath() {
  return path.resolve(__dirname, '..', 'data', 'progressionFormulas.json');
}

function loadFormulas() {
  const p = formulasPath();
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

registerRoute(router, {
  method: 'GET', path: '/progression/formulas', category: 'Progression',
  description: 'Live view of the shared progressionFormulas.json — re-read from disk on every call, so a formula added to the file appears here immediately.',
  allowedRoles: ['any authenticated admin'],
}, async (req, res) => {
  try {
    const formulas = loadFormulas();
    res.json({
      sourceFile: formulasPath(),
      count: formulas.length,
      formulas,
    });
  } catch (e) { err(res, e); }
});

registerRoute(router, {
  method: 'GET', path: '/progression/formulas/usage', category: 'Progression',
  description: 'Platform-wide formula usage: user_progression_settings rows grouped by formula_key (real SQL GROUP BY) vs the app default, with unknown/deleted-key detection against the live formulas file.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const groups = (await query(
      `SELECT formula_key, count(*)::int AS users, max(updated_at) AS last_updated
       FROM user_progression_settings GROUP BY formula_key ORDER BY users DESC`
    )).rows;
    const explicitTotal = groups.reduce((n, g) => n + g.users, 0);
    // users who never wrote a setting run on the app default ('linear_progression')
    const implicitDefaultUsers = (await query(
      `SELECT count(*)::int AS c FROM users u
       WHERE u.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM user_progression_settings s WHERE s.user_id = u.id)`
    )).rows[0].c;
    const liveKeys = new Set(loadFormulas().map((f) => f.key));
    const breakdown = groups.map((g) => ({ ...g, known: liveKeys.has(g.formula_key) }));
    const unknownKeys = breakdown.filter((g) => !g.known);
    res.json({
      breakdown,
      unknownRows: unknownKeys.reduce((n, g) => n + g.users, 0),
      unknownKeys: unknownKeys.map((g) => g.formula_key),
      totals: {
        explicitSettingsRows: explicitTotal,
        implicitDefaultUsers,
        appDefaultKey: 'linear_progression',
      },
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/progression/overrides', category: 'Progression',
  description: 'Paginated browser of every trainer→client progression override with trainer/client names+emails. Filterable by ?trainer_id=. Newest first.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.trainer_id) { params.push(req.query.trainer_id); where.push(`o.trainer_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    params.push(limit); const limitIdx = params.length;
    params.push((page - 1) * limit); const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT o.id, o.trainer_id, o.client_id, o.formula_key, o.params, o.updated_at,
              t.name AS trainer_name, t.email AS trainer_email,
              c.name AS client_name, c.email AS client_email
       FROM trainer_client_progression_overrides o
       JOIN users t ON t.id = o.trainer_id
       JOIN users c ON c.id = o.client_id
       ${whereSql}
       ORDER BY o.updated_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const total = (await query(
      `SELECT count(*)::int AS c FROM trainer_client_progression_overrides o ${whereSql}`,
      params.slice(0, where.length)
    )).rows[0].c;
    res.json({ page, limit, total, overrides: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'DELETE', path: '/progression/overrides/:id', category: 'Progression',
  description: 'Clear a stuck/incorrect trainer→client progression override entirely (the row is deleted, not just nulled). Audited.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const before = await query('SELECT * FROM trainer_client_progression_overrides WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Override not found' });
    await query('DELETE FROM trainer_client_progression_overrides WHERE id = $1', [req.params.id]);
    await writeAudit(req.admin, 'clear_progression_override', 'trainer_client_progression_overrides', req.params.id, before.rows[0], null);
    res.json({ ok: true, cleared: before.rows[0] });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

module.exports = { router };
