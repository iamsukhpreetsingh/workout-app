// Sensitive client-intake-profile administration (Phase 8). Intake profiles
// carry HEALTH DATA (allergens, goals, injuries, medical_conditions) so this
// module is deliberately split:
//   • the LISTING never returns health values — only presence booleans
//   • the DETAIL view returns everything but is read-audited on every call
//   • there is NO edit path — admins flag a profile for review instead
//     (the flag lives in admin_audit_log, no schema changes)
// Health values are NEVER written to audit log entries.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit, readAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

// ══════════════════════════ Intake Profiles (Phase 8) ═════════════════
registerRoute(router, {
  method: 'GET', path: '/intake-profiles', category: 'Intake',
  description: "Paginated metadata listing of client intake profiles — client name/email, their active trainer(s), completion timestamps and PRESENCE booleans only (never the allergens/goals/injuries/medical values themselves). Surfaces latest flag_for_review state.",
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [limit, offset];
    const { rows } = await query(
      `SELECT p.client_user_id AS id,
              u.id AS client_id,
              u.name AS client_name,
              u.email AS client_email,
              p.completed_at,
              p.created_at,
              p.updated_at,
              EXISTS (
                SELECT 1 FROM trainer_clients tc
                WHERE tc.client_id = u.id AND tc.status = 'active'
              ) AS has_trainer,
              COALESCE(array_length(p.allergens, 1), 0) > 0 AS has_allergens,
              COALESCE(array_length(p.goals, 1), 0) > 0 AS has_goals,
              p.injuries IS NOT NULL AS has_injuries,
              p.medical_conditions IS NOT NULL AS has_medical,
              (SELECT json_agg(json_build_object('name', t.name, 'email', t.email))
                 FROM trainer_clients tc JOIN users t ON t.id = tc.trainer_id
                 WHERE tc.client_id = u.id AND tc.status = 'active') AS trainers,
              f.flagged_at,
              f.flag_reason
       FROM client_intake_profiles p
       JOIN users u ON u.id = p.client_user_id
       LEFT JOIN LATERAL (
         SELECT a.created_at AS flagged_at, a.after_values ->> 'reason' AS flag_reason
         FROM admin_audit_log a
         WHERE a.action = 'flag_for_review'
           AND a.target_table = 'client_intake_profiles'
           AND a.target_id = p.client_user_id::text
         ORDER BY a.created_at DESC LIMIT 1
       ) f ON true
       ORDER BY p.updated_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    // metadata only: strip any health-value columns defensively
    const clean = rows.map(({ allergens, goals, injuries, medical_conditions, ...rest }) => rest);
    const total = (await query('SELECT count(*)::int AS c FROM client_intake_profiles')).rows[0].c;
    res.json({ total, limit, offset, profiles: clean });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'GET', path: '/intake-profiles/:id', category: 'Intake',
  description: "FULL intake profile detail including health fields (allergens, goals, injuries, medical_conditions). Viewing is itself audited via read_audit on every successful call. Never edit these disclosures — flag for review instead.",
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.*,
              u.name AS client_name,
              u.email AS client_email,
              (
                SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'email', t.email))
                FROM trainer_clients tc JOIN users t ON t.id = tc.trainer_id
                WHERE tc.client_id = u.id AND tc.status = 'active'
              ) AS trainers
       FROM client_intake_profiles p
       JOIN users u ON u.id = p.client_user_id
       WHERE p.client_user_id = $1::uuid`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Intake profile not found' });
    await readAudit(req.admin, 'view_intake_profile', 'client_intake_profiles', req.params.id);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'POST', path: '/intake-profiles/:id/flag', category: 'Intake',
  description: "Flag an intake profile for review instead of editing it — admins NEVER alter medical disclosures. The flag record lives in admin_audit_log (action='flag_for_review'); the listing surfaces flagged_at/flag_reason from it. Audited (that IS the flag).",
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const reason = ((req.body || {}).reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const exists = await query(
      'SELECT 1 FROM client_intake_profiles WHERE client_user_id = $1::uuid',
      [req.params.id]
    );
    if (!exists.rowCount) return res.status(404).json({ error: 'Intake profile not found' });
    await writeAudit(req.admin, 'flag_for_review', 'client_intake_profiles', req.params.id, null, { reason });
    res.json({ ok: true, id: req.params.id, flagged: true, reason });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

registerRoute(router, {
  method: 'GET', path: '/intake-profiles-stats/completion', category: 'Intake',
  description: 'Completion-rate metric: % of clients WITH an active trainer relationship that have a completed intake profile, plus overall intake counts.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const { rows } = await query(`
      WITH active_clients AS (
        SELECT DISTINCT tc.client_id
        FROM trainer_clients tc WHERE tc.status = 'active'
      )
      SELECT
        (SELECT count(*)::int FROM active_clients) AS clients_with_active_trainer,
        (SELECT count(*)::int
           FROM active_clients ac
           JOIN client_intake_profiles p ON p.client_user_id = ac.client_id
           WHERE p.completed_at IS NOT NULL) AS trained_clients_completed,
        (SELECT count(*)::int FROM client_intake_profiles) AS total_profiles,
        (SELECT count(*)::int FROM client_intake_profiles WHERE completed_at IS NOT NULL) AS completed_profiles,
        (SELECT count(*)::int FROM client_intake_profiles WHERE completed_at IS NULL) AS incomplete_profiles,
        CASE WHEN (SELECT count(*) FROM active_clients) = 0 THEN 0
             ELSE round(100.0 * (SELECT count(*) FROM active_clients ac
                    JOIN client_intake_profiles p ON p.client_user_id = ac.client_id
                    WHERE p.completed_at IS NOT NULL)
                  / (SELECT count(*) FROM active_clients)) END AS completion_rate_pct`);
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

module.exports = { router };
