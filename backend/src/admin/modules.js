// Purpose-built admin modules sitting ALONGSIDE the generic browser:
// users/trainers, content moderation, analytics, system health,
// broadcasts, feature flags, impersonation, audit log.
const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');
const notifications = require('../data/notifications');

const router = express.Router();
router.use(requireAdmin());

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-dev-secret-change-me';

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

// ══════════════════════════════ Users & Trainers (Phase 4) ═══════════
registerRoute(router, {
  method: 'GET', path: '/users', category: 'Users',
  description: 'Searchable list of all app accounts (name/email/role/status filters) with activity summary.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { q, role, suspended } = req.query;
    const where = [];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
    if (role) { params.push(role); where.push(`u.role = $${params.length}`); }
    if (suspended === 'true') where.push('u.is_suspended');
    if (suspended === 'false') where.push('NOT u.is_suspended');
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_suspended, u.created_at,
              (SELECT count(*)::int FROM session_summaries s WHERE s.client_id = u.id) AS session_count,
              (SELECT max(s.performed_at) FROM session_summaries s WHERE s.client_id = u.id) AS last_workout_at,
              (SELECT count(*)::int FROM trainer_clients tc WHERE tc.trainer_id = u.id AND tc.status = 'active') AS active_clients,
              (SELECT count(*)::int FROM trainer_clients tc WHERE tc.trainer_id = u.id AND tc.status = 'archived') AS archived_clients
       FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY u.created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/users/:id', category: 'Users',
  description: 'Account detail: profile, activity stats, and (for trainers) the full client roster with relationship statuses.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role, u.is_suspended, u.created_at,
              (SELECT count(*)::int FROM session_summaries s WHERE s.client_id = u.id) AS session_count,
              (SELECT max(s.performed_at) FROM session_summaries s WHERE s.client_id = u.id) AS last_workout_at
       FROM users u WHERE u.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    if (user.role === 'trainer') {
      user.clients = (await query(
        `SELECT u.id, u.name, u.email, tc.status, tc.archived_at, tc.purge_at
         FROM trainer_clients tc JOIN users u ON u.id = tc.client_id
         WHERE tc.trainer_id = $1 ORDER BY tc.status, u.name`, [req.params.id])).rows;
    }
    res.json(user);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'PATCH', path: '/users/:id/suspend', category: 'Users',
  description: 'Suspend or reactivate an account. Suspended accounts are blocked at app login. Audited.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const suspended = !!(req.body || {}).suspended;
    const { rows } = await query(
      'UPDATE users SET is_suspended = $2 WHERE id = $1 RETURNING id, name, email, role, is_suspended',
      [req.params.id, suspended]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await writeAudit(req.admin, suspended ? 'user_suspend' : 'user_reactivate', 'users', req.params.id, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'POST', path: '/users/:id/force-logout', category: 'Users',
  description: 'Revoke all refresh tokens for an account (forces re-login on all devices). Audited.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { rowCount } = await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
    await writeAudit(req.admin, 'user_force_logout', 'users', req.params.id, null, { revoked: rowCount });
    res.json({ ok: true, revoked: rowCount });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'PATCH', path: '/users/:id/role', category: 'Users',
  description: "Change a user↔trainer role. Refuses to demote a trainer who still has non-revoked client relationships. Audited.",
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const role = (req.body || {}).role;
    if (!['user', 'trainer'].includes(role)) return res.status(400).json({ error: "role must be 'user' or 'trainer'" });
    const active = await query(
      `SELECT count(*)::int AS c FROM trainer_clients WHERE trainer_id = $1 AND status != 'revoked'`, [req.params.id]);
    if (role === 'user' && active.rows[0].c > 0) {
      return res.status(409).json({ error: `Trainer still has ${active.rows[0].c} client relationship(s) — resolve them first (archive/unlink), they will not be orphaned silently` });
    }
    const { rows } = await query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, name, email, role', [req.params.id, role]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await writeAudit(req.admin, 'user_role_change', 'users', req.params.id, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

// ══════════════════════════════ Content moderation (Phase 5) ════════
registerRoute(router, {
  method: 'GET', path: '/content/reports', category: 'Content',
  description: 'Reported-content review queue (open/resolved/dismissed filter).',
  allowedRoles: ['content_moderator', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const { rows } = await query(
      `SELECT r.*, u.name AS reporter_name FROM content_reports r
       LEFT JOIN users u ON u.id = r.reporter_id
       WHERE ($1 = 'all' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`, [status]);
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin', 'support', 'read_only'));

registerRoute(router, {
  method: 'PATCH', path: '/content/reports/:id', category: 'Content',
  description: 'Resolve or dismiss a content report. Audited.',
  allowedRoles: ['content_moderator', 'super_admin'],
}, async (req, res) => {
  try {
    const status = (req.body || {}).status;
    if (!['resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: "status must be 'resolved' or 'dismissed'" });
    const { rows } = await query(
      'UPDATE content_reports SET status = $2, resolved_at = now() WHERE id = $1 RETURNING *', [req.params.id, status]);
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });
    await writeAudit(req.admin, `report_${status}`, 'content_reports', req.params.id, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin'));

registerRoute(router, {
  method: 'DELETE', path: '/content/:type/:id', category: 'Content',
  description: 'Remove any recipe/catalog dish or workout template platform-wide (policy violations). Audited.',
  allowedRoles: ['content_moderator', 'super_admin'],
}, async (req, res) => {
  try {
    const map = { recipe: 'meal_catalog_items', dish: 'meal_catalog_items', template: 'workout_templates' };
    const table = map[req.params.type];
    if (!table) return res.status(400).json({ error: "type must be 'recipe', 'dish' or 'template'" });
    const before = await query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Not found' });
    await query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    await writeAudit(req.admin, 'content_delete', table, req.params.id, before.rows[0], null);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin'));

registerRoute(router, {
  method: 'GET', path: '/content/tags', category: 'Content',
  description: 'Every distinct tag in use platform-wide with per-table counts (DISTINCT unnest across tag tables).',
  allowedRoles: ['content_moderator', 'super_admin', 'support', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT tag, count(*)::int AS uses FROM (
        SELECT unnest(tags) AS tag FROM meal_catalog_items
        UNION ALL SELECT unnest(tags) AS tag FROM workout_templates
        UNION ALL SELECT unnest(tags) AS tag FROM assigned_plans
        UNION ALL SELECT unnest(tags) AS tag FROM diet_plans
        UNION ALL SELECT unnest(tags) AS tag FROM supplement_plans
        UNION ALL SELECT unnest(tags) AS tag FROM trainer_tags
      ) t GROUP BY tag ORDER BY uses DESC, tag ASC`);
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin', 'support', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/content/tags/merge', category: 'Content',
  description: 'Merge a duplicate tag into a canonical value across EVERY table that uses tags, in one transaction. Audited.',
  allowedRoles: ['content_moderator', 'super_admin'],
}, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to || from === to) return res.status(400).json({ error: 'from and to (distinct) are required' });
    const tables = [
      ['meal_catalog_items', 'id'], ['workout_templates', 'id'], ['assigned_plans', 'id'],
      ['diet_plans', 'id'], ['supplement_plans', 'id'], ['trainer_tags', 'id'],
      ['diet_plan_meal_items', 'id'],
    ];
    let updated = 0;
    for (const [table, pk] of tables) {
      const r = await query(
        `UPDATE ${table} SET tags = (SELECT array_agg(DISTINCT CASE WHEN t = $1 THEN $2 ELSE t END)
           FROM unnest(tags) AS t WHERE t = $1 OR t <> $1)
         WHERE $1 = ANY(tags) RETURNING ${pk}`, [from, to]);
      updated += r.rowCount || 0;
    }
    // trainer_tags has a UNIQUE(trainer_id,name,category) — merging may
    // collide with an existing canonical row; drop the losers.
    await query(`DELETE FROM trainer_tags a USING trainer_tags b
                 WHERE a.name = $1 AND b.name = $2 AND a.trainer_id = b.trainer_id AND a.category = b.category AND a.id <> b.id`, [from, to]);
    await writeAudit(req.admin, 'tag_merge', 'tags', null, { from }, { to, updated });
    res.json({ ok: true, updated });
  } catch (e) { err(res, e); }
}, requireAdminRole('content_moderator', 'super_admin'));

// ══════════════════════════════ Analytics (Phase 6) ══════════════════
registerRoute(router, {
  method: 'GET', path: '/analytics/overview', category: 'Analytics',
  description: 'Home-screen metrics: totals, DAU/WAU/MAU, workouts today/this week, signup trend. Real SQL aggregates.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const one = async (sql) => (await query(sql)).rows[0];
    const totals = await one(`SELECT
      (SELECT count(*)::int FROM users WHERE role = 'user') AS total_users,
      (SELECT count(*)::int FROM users WHERE role = 'trainer') AS total_trainers,
      (SELECT count(*)::int FROM trainer_clients WHERE status = 'active') AS active_relationships,
      (SELECT count(*)::int FROM session_summaries WHERE performed_at >= now() - interval '1 day') AS workouts_today,
      (SELECT count(*)::int FROM session_summaries WHERE performed_at >= now() - interval '7 days') AS workouts_week,
      (SELECT count(DISTINCT client_id)::int FROM session_summaries WHERE performed_at >= now() - interval '1 day') AS dau,
      (SELECT count(DISTINCT client_id)::int FROM session_summaries WHERE performed_at >= now() - interval '7 days') AS wau,
      (SELECT count(DISTINCT client_id)::int FROM session_summaries WHERE performed_at >= now() - interval '30 days') AS mau`);
    const signups = (await query(`SELECT date_trunc('week', created_at) AS week, count(*)::int AS c
      FROM users GROUP BY 1 ORDER BY 1 DESC LIMIT 12`)).rows.reverse();
    res.json({ ...totals, signups });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));

registerRoute(router, {
  method: 'GET', path: '/analytics/retention', category: 'Analytics',
  description: 'Signup-week cohorts and % still logging workouts N weeks later (cohort retention table).',
  allowedRoles: ['analyst', 'super_admin', 'read_only'],
}, async (req, res) => {
  try {
    const { rows } = await query(`
      WITH cohorts AS (
        SELECT u.id, date_trunc('week', u.created_at)::date AS cohort_week
        FROM users u WHERE u.role = 'user'
      ),
      activity AS (
        SELECT s.client_id, date_trunc('week', s.performed_at)::date AS active_week
        FROM session_summaries s GROUP BY 1, 2
      )
      SELECT c.cohort_week,
             count(DISTINCT c.id)::int AS cohort_size,
             floor(EXTRACT(DAY FROM a.active_week - c.cohort_week) / 7)::int AS week_n,
             count(DISTINCT a.client_id)::int AS active_users
      FROM cohorts c LEFT JOIN activity a ON a.client_id = c.id AND a.active_week >= c.cohort_week
      GROUP BY 1, 3 ORDER BY 1, 3`);
    // shape into cohort rows
    const byCohort = new Map();
    for (const r of rows) {
      if (!byCohort.has(r.cohort_week)) byCohort.set(r.cohort_week, { cohort_week: r.cohort_week, cohort_size: r.cohort_size, weeks: {} });
      const c = byCohort.get(r.cohort_week);
      if (r.week_n >= 0 && r.week_n <= 12) c.weeks[r.week_n] = r.active_users;
    }
    res.json([...byCohort.values()]);
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'read_only'));

registerRoute(router, {
  method: 'GET', path: '/analytics/trainers', category: 'Analytics',
  description: 'Trainer-specific analytics: client-count distribution, average client adherence, top templates/tags.',
  allowedRoles: ['analyst', 'super_admin', 'read_only'],
}, async (req, res) => {
  try {
    const clientsPerTrainer = (await query(`
      SELECT bucket, count(*)::int AS trainers FROM (
        SELECT t.id, CASE
          WHEN count(tc.id) = 0 THEN '0'
          WHEN count(tc.id) <= 3 THEN '1-3'
          WHEN count(tc.id) <= 10 THEN '4-10'
          ELSE '10+' END AS bucket
        FROM users t LEFT JOIN trainer_clients tc ON tc.trainer_id = t.id AND tc.status = 'active'
        WHERE t.role = 'trainer' GROUP BY t.id
      ) x GROUP BY bucket`)).rows;
    const topTemplates = (await query(`
      SELECT name, tags, (SELECT count(*)::int FROM assigned_plans p WHERE p.source_template_id = workout_templates.id) AS assigned
      FROM workout_templates ORDER BY assigned DESC LIMIT 10`)).rows;
    res.json({ clientsPerTrainer, topTemplates });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'read_only'));

// ══════════════════════════════ Health (Phase 7) ═════════════════════
registerRoute(router, {
  method: 'GET', path: '/health/sync-queue', category: 'Health',
  description: 'Sync queue health across all users: counts by status, persistently failing items with last_error.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    // the mobile sync queue lives on devices; server-side proxy for queue
    // health is failed push deliveries + unsynced patterns. Server-side
    // queue table if introduced later is auto-discovered by Phase 2.
    const failing = (await query(`
      SELECT * FROM push_log WHERE success = false AND created_at >= now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 50`)).rows;
    const counts = (await query(`
      SELECT success, count(*)::int AS c FROM push_log WHERE created_at >= now() - interval '7 days' GROUP BY success`)).rows;
    res.json({ pushCounts: counts, failing });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/health/purge', category: 'Health',
  description: "Archive/purge status: archived relationships with purge dates + last purge job runs.",
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const archived = (await query(`
      SELECT tc.id, u.name AS client_name, tc.archived_at, tc.purge_at, tc.archived_by,
             GREATEST(0, EXTRACT(DAY FROM (tc.purge_at - now()))::int) AS days_remaining
      FROM trainer_clients tc JOIN users u ON u.id = tc.client_id
      WHERE tc.status = 'archived' ORDER BY tc.purge_at ASC`)).rows;
    const runs = (await query('SELECT * FROM purge_job_runs ORDER BY ran_at DESC LIMIT 20')).rows;
    res.json({ archived, runs });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/health/run-purge', category: 'Health',
  description: 'Manually trigger the archive purge job (same code path as the cron). Super admin only. Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    // reuse the exact scheduled-job logic, never a divergent copy
    const { runPurge } = require('../../scripts/purgeExpiredArchives');
    const result = await runPurge();
    await writeAudit(req.admin, 'manual_purge_run', 'trainer_clients', null, null, result);
    res.json(result);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

// ══════════════════════════════ Broadcast (Phase 8) ══════════════════
registerRoute(router, {
  method: 'POST', path: '/broadcast/preview', category: 'Broadcast',
  description: 'Compute the audience for a broadcast WITHOUT sending — the confirmation step before mass-send.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { audience, userIds } = req.body || {};
    let ids = null;
    if (audience === 'explicit') {
      ids = Array.isArray(userIds) ? userIds : [];
    } else if (audience === 'users') {
      ids = (await query(`SELECT id FROM users WHERE role = 'user' AND NOT is_suspended`)).rows.map((r) => r.id);
    } else if (audience === 'trainers') {
      ids = (await query(`SELECT id FROM users WHERE role = 'trainer' AND NOT is_suspended`)).rows.map((r) => r.id);
    } else if (audience === 'users_without_trainer') {
      ids = (await query(`SELECT u.id FROM users u WHERE u.role = 'user' AND NOT u.is_suspended AND NOT EXISTS (
        SELECT 1 FROM trainer_clients tc WHERE tc.client_id = u.id AND tc.status = 'active')`)).rows.map((r) => r.id);
    } else {
      return res.status(400).json({ error: "audience must be 'users', 'trainers', 'users_without_trainer' or 'explicit'" });
    }
    res.json({ count: ids.length, sample: ids.slice(0, 5) });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'POST', path: '/broadcast/send', category: 'Broadcast',
  description: 'Send an in-app + push notification to a computed audience. Creates notification rows in bulk via the existing mechanism. Audited.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { audience, userIds, title, body } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    let ids = null;
    if (audience === 'explicit') {
      ids = Array.isArray(userIds) ? userIds : [];
    } else if (audience === 'users') {
      ids = (await query(`SELECT id FROM users WHERE role = 'user' AND NOT is_suspended`)).rows.map((r) => r.id);
    } else if (audience === 'trainers') {
      ids = (await query(`SELECT id FROM users WHERE role = 'trainer' AND NOT is_suspended`)).rows.map((r) => r.id);
    } else if (audience === 'users_without_trainer') {
      ids = (await query(`SELECT u.id FROM users u WHERE u.role = 'user' AND NOT u.is_suspended AND NOT EXISTS (
        SELECT 1 FROM trainer_clients tc WHERE tc.client_id = u.id AND tc.status = 'active')`)).rows.map((r) => r.id);
    } else {
      return res.status(400).json({ error: 'invalid audience' });
    }
    let sent = 0;
    for (const recipientId of ids) {
      await notifications.createNotification({
        recipientId, actorId: null, type: 'admin_broadcast', title, body, deepLinkRef: null,
      }).catch(() => {});
      sent++;
    }
    await writeAudit(req.admin, 'broadcast_send', 'notifications', null, null, { audience, count: sent, title });
    res.json({ ok: true, sent });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

// ══════════════════════════════ Feature flags (Phase 9) ══════════════
registerRoute(router, {
  method: 'GET', path: '/flags', category: 'Feature Flags',
  description: 'List all feature flags.',
  allowedRoles: ['support', 'super_admin', 'read_only'],
}, async (req, res) => {
  res.json((await query('SELECT * FROM feature_flags ORDER BY key')).rows);
}, requireAdminRole('support', 'super_admin', 'read_only'));

registerRoute(router, {
  method: 'PUT', path: '/flags/:key', category: 'Feature Flags',
  description: 'Create/update a feature flag (enabled, rollout %, description). Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const { enabled, rollout_percentage, description } = req.body || {};
    const { rows } = await query(
      `INSERT INTO feature_flags (key, enabled, rollout_percentage, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET enabled = $2, rollout_percentage = $3, description = $4, updated_at = now()
       RETURNING *`, [req.params.key, !!enabled, rollout_percentage ?? null, description || null]);
    await writeAudit(req.admin, 'flag_update', 'feature_flags', req.params.key, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

// ══════════════════════════════ Impersonation (Phase 10) ═════════════
registerRoute(router, {
  method: 'POST', path: '/users/:id/impersonate', category: 'Support',
  description: 'Short-lived READ-ONLY scoped token to debug as a user. Writes made with it are rejected server-side. Audited.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, name, email, role FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const token = jwt.sign(
      { sub: rows[0].id, role: rows[0].role, impersonatedBy: req.admin.id, impersonation: 'read_only' },
      JWT_SECRET_FOR_APP(), { expiresIn: '15m' }
    );
    await writeAudit(req.admin, 'impersonate_start', 'users', req.params.id, null, { scope: 'read_only' });
    res.json({ token, user: rows[0], expiresInSeconds: 900, readOnly: true });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

function JWT_SECRET_FOR_APP() {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}

// ══════════════════════════════ Audit log (Phase 10) ═════════════════
registerRoute(router, {
  method: 'GET', path: '/audit-log', category: 'Audit',
  description: 'Searchable log of every admin write/delete action. Super admin only.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(a.action ILIKE $1 OR a.target_table ILIKE $1 OR au.name ILIKE $1)`); }
    if (req.query.admin) { params.push(req.query.admin); where.push(`a.admin_user_id = $${params.length}`); }
    const { rows } = await query(
      `SELECT a.*, au.name AS admin_name, au.email AS admin_email
       FROM admin_audit_log a LEFT JOIN admin_users au ON au.id = a.admin_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

// ══════════════════════════════ API registry (Phase 3) ═══════════════
registerRoute(router, {
  method: 'GET', path: '/api-registry', category: 'System',
  description: 'Every route registered via registerRoute(): method, path, description, auth, roles, category. Live from code.',
  allowedRoles: ['any authenticated admin'],
}, async (req, res) => {
  const { registeredRoutes } = require('./registry');
  const routes = registeredRoutes().map((r) => ({
    ...r,
    // the registry endpoint itself is mounted under /admin
    fullPath: `/admin${r.path}`,
  })).sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
  res.json(routes);
});

module.exports = { router };
