// Trainer-client relationship lifecycle admin module (ADMIN.md Phase 5):
// relationship-centric list with archive/purge visibility, badge counts,
// super-admin interventions (extend purge, force revoke, manual restore)
// and purge-job run history + on-demand runs sharing the exact cron code path.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

// ════════════════════ Relationships (Phase 5) ════════════════════════
registerRoute(router, {
  method: 'GET', path: '/relationships', category: 'Relationships',
  description: 'Paginated relationship-centric list (trainer+client names/emails) filterable by status, upcoming purge window, or reactivation requests awaiting a trainer decision.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { status, purgeWithinDays, reactivationAwaiting } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const where = [];
    const params = [];
    if (status) {
      if (!['pending', 'active', 'archived', 'revoked'].includes(status)) {
        return res.status(400).json({ error: "status must be pending|active|archived|revoked" });
      }
      params.push(status);
      where.push(`tc.status = $${params.length}`);
    }
    if (purgeWithinDays !== undefined) {
      const days = parseInt(purgeWithinDays, 10);
      if (!(days > 0)) return res.status(400).json({ error: 'purgeWithinDays must be a positive integer' });
      params.push(days);
      where.push(`tc.status = 'archived' AND tc.purge_at IS NOT NULL AND tc.purge_at BETWEEN now() AND now() + ($${params.length} * interval '1 day')`);
    }
    if (reactivationAwaiting === '1') {
      // No final_decision column exists in the schema; an archived row that a
      // client asked to reactivate moves to status='pending' with
      // restore_preference set until the trainer accepts/declines.
      where.push(`tc.status = 'pending' AND tc.restore_preference IS NOT NULL`);
    }
    params.push(limit); const pLimit = params.length;
    params.push((page - 1) * limit); const pOffset = params.length;
    const { rows } = await query(
      `SELECT tc.*, tu.name AS trainer_name, tu.email AS trainer_email,
              cu.name AS client_name, cu.email AS client_email,
              GREATEST(0, EXTRACT(DAY FROM (tc.purge_at - now()))::int) AS days_until_purge
       FROM trainer_clients tc
       JOIN users tu ON tu.id = tc.trainer_id
       JOIN users cu ON cu.id = tc.client_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY tc.created_at DESC LIMIT $${pLimit} OFFSET $${pOffset}`,
      params
    );
    res.json({ page, limit, relationships: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/relationships/pending-count', category: 'Relationships',
  description: 'Quick relationship totals grouped by status (pending/active/archived/revoked) plus open reactivation requests, for dashboard badges.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const byStatus = (await query(
      'SELECT status, count(*)::int AS c FROM trainer_clients GROUP BY status'
    )).rows.reduce((m, r) => ({ ...m, [r.status]: r.c }), {});
    const reactivationAwaiting = (await query(
      `SELECT count(*)::int AS c FROM trainer_clients WHERE status = 'pending' AND restore_preference IS NOT NULL`
    )).rows[0].c;
    res.json({ ...byStatus, reactivation_awaiting: reactivationAwaiting });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/relationships/:id/extend-purge', category: 'Relationships',
  description: 'Extend the purge countdown of an archived relationship by N days (grace period before irreversible data deletion). Super admin only. Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const days = parseInt((req.body || {}).days, 10);
    if (!(days > 0)) return res.status(400).json({ error: 'days must be a positive integer' });
    const before = await query(
      `SELECT id, status, purge_at FROM trainer_clients WHERE id = $1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Relationship not found' });
    if (!before.rows[0].purge_at) return res.status(409).json({ error: 'Relationship has no scheduled purge_at (not archived)' });
    const { rows } = await query(
      `UPDATE trainer_clients SET purge_at = purge_at + ($2 * interval '1 day') WHERE id = $1 RETURNING id, status, purge_at`,
      [req.params.id, days]
    );
    await writeAudit(req.admin, 'force_extend_purge', 'trainer_clients', req.params.id,
      { purge_at: before.rows[0].purge_at }, { purge_at: rows[0].purge_at, extended_days: days });
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

registerRoute(router, {
  method: 'POST', path: '/relationships/:id/force-revoke', category: 'Relationships',
  description: 'Immediately terminate any relationship regardless of current status (no schema revoked_at column exists, so responded_at marks the action time). Super admin only. Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trainer_clients SET status = 'revoked', responded_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Relationship not found' });
    await writeAudit(req.admin, 'force_revoke', 'trainer_clients', req.params.id, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

registerRoute(router, {
  method: 'POST', path: '/relationships/:id/restore', category: 'Relationships',
  description: 'Manually reactivate an archived relationship to active (clears archived_at/archived_by/purge_at/restore_preference); refuses anything not currently archived. Super admin only. Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const existing = await query('SELECT status FROM trainer_clients WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Relationship not found' });
    if (existing.rows[0].status !== 'archived') {
      return res.status(409).json({ error: `Only archived relationships can be restored (current status: ${existing.rows[0].status})` });
    }
    const { rows } = await query(
      `UPDATE trainer_clients SET status = 'active', responded_at = now(),
              archived_at = NULL, archived_by = NULL, purge_at = NULL,
              restore_preference = NULL
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await writeAudit(req.admin, 'force_restore', 'trainer_clients', req.params.id, null, rows[0]);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

// ════════════════════ Purge runs (Phase 5) ═══════════════════════════
registerRoute(router, {
  method: 'GET', path: '/purge-runs', category: 'Relationships',
  description: 'Last 50 purge job runs (timestamp, rows/relationships purged, errors) from the same log the daily cron writes.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM purge_job_runs ORDER BY ran_at DESC LIMIT 50');
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/purge-runs/run', category: 'Relationships',
  description: 'Trigger the archive purge job immediately using the exact exported function the daily cron calls (run logged to purge_job_runs). Super admin only. Audited.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    // reuse the exact scheduled-job logic, never a divergent copy
    const { runPurge } = require('../scripts/purgeExpiredArchives');
    const result = await runPurge();
    await writeAudit(req.admin, 'manual_purge_run', 'trainer_clients', null, null, result);
    res.json(result);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

module.exports = { router };
