// ADMIN.md Phase 12 analytics completion + Phase 4 user-management remainder.
// Sits ALONGSIDE modules.js using the same conventions: registerRoute(),
// requireAdmin() on the router, role guard as trailing middleware,
// try/catch + err() in every handler, parameterized SQL only.
//
// Mount next to the other admin routers in server.js:
//   app.use('/admin', adminAnalyticsExtra.router);
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

// auth.js hashes with cost 11 — keep identical so app login still verifies
const BCRYPT_COST = 11;
const ANALYST_ROLES = ['analyst', 'support', 'super_admin', 'read_only'];

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

const daysInterval = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : 90;
};

// ══════════════════════════════ Analytics (Phase 12) ═════════════════

registerRoute(router, {
  method: 'GET', path: '/analytics/conversion-funnel', category: 'Analytics',
  description: 'Signup → intake-profile → first-workout conversion for users who signed up in the ?days= window (default 90). CTE-based.',
  allowedRoles: ANALYST_ROLES,
}, async (req, res) => {
  try {
    const days = daysInterval(req.query.days);
    const { rows } = await query(`
      WITH cohort AS (
        SELECT id FROM users
        WHERE role = 'user' AND created_at >= now() - ($1::text || ' days')::interval
      ),
      completed_intake AS (
        SELECT client_user_id FROM client_intake_profiles WHERE completed_at IS NOT NULL
      ),
      has_worked_out AS (
        SELECT DISTINCT client_id FROM session_summaries
      )
      SELECT
        count(*)::int AS signed_up,
        count(i.client_user_id)::int AS with_completed_intake,
        count(w.client_id)::int AS with_first_workout,
        count(*) FILTER (WHERE i.client_user_id IS NOT NULL AND w.client_id IS NOT NULL)::int AS with_both
      FROM cohort c
      LEFT JOIN completed_intake i ON i.client_user_id = c.id
      LEFT JOIN has_worked_out w ON w.client_id = c.id`, [String(days)]);
    const s = rows[0];
    const pct = (n) => (s.signed_up ? Math.round((n / s.signed_up) * 1000) / 10 : null);
    res.json({
      windowDays: days,
      signedUp: s.signed_up,
      withCompletedIntake: { count: s.with_completed_intake, pct: pct(s.with_completed_intake) },
      withFirstWorkout: { count: s.with_first_workout, pct: pct(s.with_first_workout) },
      throughBoth: { count: s.with_both, pct: pct(s.with_both) },
    });
  } catch (e) { err(res, e); }
}, requireAdminRole(...ANALYST_ROLES));

registerRoute(router, {
  method: 'GET', path: '/analytics/coaching', category: 'Analytics',
  description: 'Coaching load: avg clients per active trainer, active-vs-archived utilization distribution, time-to-first-assignment, platform diet & supplement adherence (last 30 days).',
  allowedRoles: ANALYST_ROLES,
}, async (req, res) => {
  try {
    // Per-trainer relationship counts → aggregate distribution.
    // Utilization share = archived / (active + archived); NULL when a
    // trainer has no resolved relationships either way.
    const utilization = (await query(`
      WITH per_trainer AS (
        SELECT t.id,
               count(tc.id) FILTER (WHERE tc.status = 'active')::int AS active_clients,
               count(tc.id) FILTER (WHERE tc.status = 'archived')::int AS archived_clients,
               CASE WHEN count(tc.id) FILTER (WHERE tc.status IN ('active','archived')) > 0
                    THEN count(tc.id) FILTER (WHERE tc.status = 'archived')::numeric
                         / count(tc.id) FILTER (WHERE tc.status IN ('active','archived'))
               END AS archived_share
        FROM users t
        LEFT JOIN trainer_clients tc ON tc.trainer_id = t.id AND tc.status IN ('active', 'archived')
        WHERE t.role = 'trainer'
        GROUP BY t.id
      )
      SELECT
        round(avg(active_clients)::numeric, 2)::float AS avg_active_clients_per_trainer,
        max(active_clients)::int AS max_active_clients,
        round(avg(archived_share)::numeric, 4)::float AS avg_archived_share,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY archived_share))::numeric, 4)::float AS median_archived_share,
        count(*) FILTER (WHERE active_clients = 0 AND archived_clients = 0)::int AS trainers_with_no_relationships,
        count(*)::int AS trainers_total
      FROM per_trainer`)).rows[0];

    // trainer_clients.created_at → that client's FIRST assigned_plan by the
    // SAME trainer; averaged over pairs where an assignment actually happened.
    const ttf = (await query(`
      WITH first_assignment AS (
        SELECT tc.id AS rel_id,
               EXTRACT(EPOCH FROM (MIN(ap.created_at) - tc.created_at)) / 3600.0 AS hours
        FROM trainer_clients tc
        JOIN assigned_plans ap ON ap.trainer_id = tc.trainer_id AND ap.client_id = tc.client_id
        GROUP BY tc.id, tc.created_at
      )
      SELECT count(*)::int AS assignments_measured,
             round(avg(hours)::numeric, 1)::float AS avg_hours,
             round(avg(hours) / 24.0::numeric, 1)::float AS avg_days
      FROM first_assignment`)).rows[0];

    // Adherence: yes-checkins / all checkins in the trailing 30 days.
    const adherence = (await query(`
      SELECT
        (SELECT count(*) FILTER (WHERE followed))::int AS diet_yes,
        count(*)::int AS diet_total,
        (SELECT count(*) FILTER (WHERE taken) FROM supplement_checkins WHERE date >= CURRENT_DATE - 30)::int AS supp_yes,
        (SELECT count(*) FROM supplement_checkins WHERE date >= CURRENT_DATE - 30)::int AS supp_total
      FROM diet_checkins WHERE date >= CURRENT_DATE - 30`)).rows[0];

    res.json({
      trainers: utilization,
      timeToFirstAssignment: {
        measuredRelationships: ttf.assignments_measured,
        avgHours: ttf.avg_hours,
        avgDays: ttf.avg_days,
        note: 'trainer_clients.created_at → first assigned_plan.created_at per (trainer, client) pair',
      },
      dietAdherence30d: adherence.diet_total
        ? { yes: adherence.diet_yes, total: adherence.diet_total, rate: Math.round((adherence.diet_yes / adherence.diet_total) * 1000) / 10 }
        : { yes: 0, total: 0, rate: null },
      supplementAdherence30d: adherence.supp_total
        ? { yes: adherence.supp_yes, total: adherence.supp_total, rate: Math.round((adherence.supp_yes / adherence.supp_total) * 1000) / 10 }
        : { yes: 0, total: 0, rate: null },
    });
  } catch (e) { err(res, e); }
}, requireAdminRole(...ANALYST_ROLES));

registerRoute(router, {
  method: 'GET', path: '/analytics/content-health', category: 'Analytics',
  description: 'Most- and least-used workout templates (assigned_plans.source_template_id) and catalog dishes (diet_plan_meal_items.catalog_item_id). Recipes have no separate table/usage tracking — see note.',
  allowedRoles: ANALYST_ROLES,
}, async (req, res) => {
  try {
    const templates = (await query(`
      WITH use_counts AS (
        SELECT wt.id, wt.name, wt.trainer_id, count(ap.id)::int AS times_assigned
        FROM workout_templates wt
        LEFT JOIN assigned_plans ap ON ap.source_template_id = wt.id
        GROUP BY wt.id
      )
      SELECT id, name, trainer_id, times_assigned FROM use_counts`)).rows;

    // "Recipes" here = meal_catalog_items (the trainer dish library; some carry
    // recipe_url). There is NO dedicated recipes table, so recipe usage is not
    // separately trackable — we report catalog-dish usage instead.
    const dishes = (await query(`
      WITH use_counts AS (
        SELECT mci.id, mci.name, mci.trainer_id,
               (mci.recipe_url IS NOT NULL) AS has_recipe_url,
               count(dpmi.id)::int AS times_used_in_plans
        FROM meal_catalog_items mci
        LEFT JOIN diet_plan_meal_items dpmi ON dpmi.catalog_item_id = mci.id
        GROUP BY mci.id
      )
      SELECT id, name, trainer_id, has_recipe_url, times_used_in_plans FROM use_counts`)).rows;

    const top = (arr, key, n) => [...arr].sort((a, b) => b[key] - a[key]).slice(0, n);
    const bottom = (arr, key, n) => [...arr].sort((a, b) => a[key] - b[key] || a.name.localeCompare(b.name)).slice(0, n);

    res.json({
      templates: {
        mostUsed: top(templates, 'times_assigned', 10),
        leastUsed: bottom(templates, 'times_assigned', 10),
        neverAssigned: templates.filter((t) => t.times_assigned === 0).length,
        total: templates.length,
      },
      dishes: {
        mostUsed: top(dishes, 'times_used_in_plans', 10),
        leastUsed: bottom(dishes, 'times_used_in_plans', 10),
        total: dishes.length,
        note: 'meal_catalog_items used as a proxy for recipes — no standalone recipes table or per-recipe usage tracking exists in the schema',
      },
    });
  } catch (e) { err(res, e); }
}, requireAdminRole(...ANALYST_ROLES));

registerRoute(router, {
  method: 'GET', path: '/analytics/feature-adoption', category: 'Analytics',
  description: 'Feature adoption: custom progression formulas vs default, % of synced exercises swapped mid-session (session_exercise_details.original_exercise_name), % of diet-plan followers who ever logged a swap.',
  allowedRoles: ANALYST_ROLES,
}, async (req, res) => {
  try {
    const progression = (await query(`
      SELECT
        count(*)::int AS configured_users,
        count(*) FILTER (WHERE formula_key <> 'linear_progression')::int AS custom_formula_users,
        count(*) FILTER (WHERE formula_key = 'linear_progression')::int AS default_formula_users
      FROM user_progression_settings`)).rows[0];
    const totalUsers = (await query(`SELECT count(*)::int AS c FROM users WHERE role = 'user'`)).rows[0].c;

    // Migration 028 added original_exercise_name to session_exercise_details:
    // populated ONLY when the client swapped mid-session, NULL = as planned.
    const substitution = (await query(`
      SELECT count(*)::int AS exercise_rows,
             count(original_exercise_name)::int AS swapped_rows,
             count(DISTINCT sed.session_summary_id) FILTER (WHERE sed.original_exercise_name IS NOT NULL)::int AS sessions_with_swaps
      FROM session_exercise_details sed`)).rows[0];

    // Denominator: distinct clients holding any diet plan (any status).
    const swaps = (await query(`
      SELECT
        (SELECT count(DISTINCT dp.client_id)::int FROM diet_plans dp) AS diet_plan_users,
        (SELECT count(DISTINCT dis.user_id)::int FROM diet_item_swaps dis) AS swap_users`)).rows[0];

    res.json({
      progressionFormula: {
        configuredUsers: progression.configured_users,
        customFormulaUsers: progression.custom_formula_users,
        defaultFormulaUsers: progression.default_formula_users,
        pctCustomAmongConfigured: progression.configured_users
          ? Math.round((progression.custom_formula_users / progression.configured_users) * 1000) / 10 : null,
        note: 'settings rows are created lazily on first write; users without a row run the app default (linear_progression)',
      },
      exerciseSubstitution: {
        syncedExerciseRows: substitution.exercise_rows,
        swappedRows: substitution.swapped_rows,
        pctSwapped: substitution.exercise_rows
          ? Math.round((substitution.swapped_rows / substitution.exercise_rows) * 1000) / 10 : null,
        sessionsWithSwaps: substitution.sessions_with_swaps,
      },
      dietSwaps: {
        dietPlanUsers: swaps.diet_plan_users,
        everSwappedUsers: swaps.swap_users,
        pctEverSwapped: swaps.diet_plan_users
          ? Math.round((swaps.swap_users / swaps.diet_plan_users) * 1000) / 10 : null,
      },
    });
  } catch (e) { err(res, e); }
}, requireAdminRole(...ANALYST_ROLES));

// ══════════════════ Users remainder (Phase 4 support) ════════════════

registerRoute(router, {
  method: 'GET', path: '/users-sync-overview', category: 'Users',
  description: 'Per-account sync health from device-posted telemetry: latest sync_status_reports rows + recent restore_runs. {reported:false} when nothing was ever posted.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const exists = await query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'User not found' });
    const reports = (await query(
      `SELECT reported_at, pending_count, failed_count, queue_by_entity_type, failing_items, app_version
       FROM sync_status_reports WHERE user_id = $1 ORDER BY reported_at DESC LIMIT 5`, [userId])).rows;
    if (!reports.length) return res.json({ reported: false });
    const restores = (await query(
      `SELECT started_at, completed_at, status, duration_ms, failed_step
       FROM restore_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 5`, [userId])).rows;
    res.json({
      reported: true,
      latestReport: reports[0],
      recentReports: reports,
      recentRestoreRuns: restores,
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/users/:id/password-reset', category: 'Users',
  description: 'Generate a 12-char temp password, set it on the account (bcrypt cost 11, matching auth.js), revoke all refresh tokens, return it ONCE. Audited WITHOUT recording the password.',
  allowedRoles: ['support', 'super_admin'],
}, async (req, res) => {
  try {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(12);
    const tempPassword = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);

    const { rows } = await query(
      `UPDATE users SET password_hash = $2, updated_at = now()
       WHERE id = $1 RETURNING id, name, email`,
      [req.params.id, passwordHash]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    // mirror force-logout in modules.js: kill every live session immediately
    const revoked = await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [req.params.id]);

    // SECURITY: before/after stay null — the plaintext is shown exactly once
    // in this response and must never land in admin_audit_log.
    await writeAudit(req.admin, 'password_reset', 'users', req.params.id, null,
      { redacted: true, revokedTokens: revoked.rowCount || 0 });

    res.json({
      ok: true,
      tempPassword,
      user: rows[0],
      revokedRefreshTokens: revoked.rowCount || 0,
      warning: 'Share this password securely — it cannot be retrieved again',
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin'));

module.exports = { router };
