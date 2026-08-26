// Admin module — Notifications volume (Phase 10) + Sync/Backup/Restore
// health (Phase 11). Read-only telemetry over notifications/push_log,
// sync_status_reports, restore_runs and backup_progress_photos.
//
// NOTE on device queues: the authoritative sync queue lives in SQLite ON the
// device; sync_status_reports/restore_runs are fire-and-forget projections
// posted by src/routes/syncReport.js. Nothing here can retry a device queue
// — retries always happen on-device when the app next syncs.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');
const notifications = require('../data/notifications');

const router = express.Router();
router.use(requireAdmin());

const err = (res, e, fallback = 500) => res.status(e.status || fallback).json({ error: e.message || 'Error' });

function intParam(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ════════════════════ Notifications volume (Phase 10) ═════════════════
registerRoute(router, {
  method: 'GET', path: '/notifications/volume', category: 'Notifications',
  description: 'Per-type notification volume per day over the last N days (?days=30, max 365). Zero-filled so gaps are visible.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const days = intParam(req.query.days, 30, 1, 365);
    const { rows } = await query(
      `SELECT type, to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS c
       FROM notifications
       WHERE created_at >= now() - make_interval(days => $1)
       GROUP BY 1, 2 ORDER BY 2`,
      [days]
    );
    // zero-fill the calendar in JS so missing days/types show as 0
    const types = [...new Set(rows.map((r) => r.type))].sort();
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
      dayList.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    const byKey = new Map(rows.map((r) => [`${r.day}|${r.type}`, r.c]));
    const series = dayList.map((day) => {
      const counts = {};
      let total = 0;
      for (const t of types) {
        const c = byKey.get(`${day}|${t}`) || 0;
        counts[t] = c;
        total += c;
      }
      return { date: day, counts, total };
    });
    res.json({ days, types, series, grandTotal: rows.reduce((s, r) => s + r.c, 0) });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/notifications/delivery-stats', category: 'Notifications',
  description: 'Push delivery outcomes from push_log: overall success/failure counts plus the 20 most recent failures with error text.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const totals = (await query(
      `SELECT count(*) FILTER (WHERE success)::int AS delivered,
              count(*) FILTER (WHERE NOT success)::int AS failed,
              count(*)::int AS total
       FROM push_log`
    )).rows[0];
    const recentFailures = (await query(
      `SELECT p.id, p.user_id, u.email AS user_email, p.token, p.error_detail, p.created_at
       FROM push_log p LEFT JOIN users u ON u.id = p.user_id
       WHERE p.success = false
       ORDER BY p.created_at DESC LIMIT 20`
    )).rows;
    res.json({ totals, recentFailures });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

// ════════════════════ Sync / restore health (Phase 11) ════════════════
registerRoute(router, {
  method: 'GET', path: '/sync/overview', category: 'Health',
  description: 'Latest sync snapshot per user from sync_status_reports: summed pending/failed, reporting users in last 24h, and pending/failed broken down by entity_type.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    // newest report per user via DISTINCT ON, then aggregate in JS
    const latest = (await query(
      `SELECT DISTINCT ON (user_id)
              user_id, pending_count, failed_count, queue_by_entity_type, reported_at, app_version
       FROM sync_status_reports
       ORDER BY user_id, reported_at DESC`
    )).rows;
    const reporting24h = (await query(
      `SELECT count(DISTINCT user_id)::int AS c
       FROM sync_status_reports
       WHERE reported_at >= now() - interval '24 hours'`
    )).rows[0].c;

    let totalPending = 0;
    let totalFailed = 0;
    const byEntityType = {};
    for (const r of latest) {
      totalPending += r.pending_count || 0;
      totalFailed += r.failed_count || 0;
      const q = r.queue_by_entity_type && typeof r.queue_by_entity_type === 'object'
        ? r.queue_by_entity_type : {};
      for (const [entityType, v] of Object.entries(q)) {
        if (!byEntityType[entityType]) byEntityType[entityType] = { pending: 0, failed: 0 };
        byEntityType[entityType].pending += Number(v?.pending) || 0;
        byEntityType[entityType].failed += Number(v?.failed) || 0;
      }
    }
    res.json({
      reportingUsers: latest.length,
      reportingUsersLast24h: reporting24h,
      totalPending,
      totalFailed,
      byEntityType,
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/sync/failing', category: 'Health',
  description: 'Persistently-failing sync items from the last 7 days: worst attempt per (user, entity_type, entity_id), sortable by attempts or recency (?sort=attempts|reported_at|user, ?limit=50).',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const limit = intParam(req.query.limit, 50, 1, 500);
    const sortMap = {
      attempts: 'attempts DESC, reported_at DESC',
      reported_at: 'reported_at DESC, attempts DESC',
      user: 'user_email ASC, attempts DESC',
    };
    const orderBy = sortMap[req.query.sort] || sortMap.attempts;
    const { rows } = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.user_id, item->>'entity_type', item->>'entity_id')
                s.user_id,
                u.email AS user_email,
                s.reported_at,
                s.app_version,
                item->>'entity_type' AS entity_type,
                item->>'entity_id' AS entity_id,
                item->>'operation' AS operation,
                COALESCE((item->>'attempts')::int, 0) AS attempts,
                item->>'error' AS last_error
         FROM sync_status_reports s
         JOIN users u ON u.id = s.user_id
         CROSS JOIN LATERAL jsonb_array_elements(s.failing_items) AS item
         WHERE s.failing_items IS NOT NULL
           AND s.reported_at >= now() - interval '7 days'
         ORDER BY s.user_id, item->>'entity_type', item->>'entity_id',
                  COALESCE((item->>'attempts')::int, 0) DESC, s.reported_at DESC
       ) worst
       ORDER BY ${orderBy}
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/restore/stats', category: 'Health',
  description: 'Restore-flow monitoring from restore_runs: 30-day run totals, success rate, avg duration for successes, per-step avg ms, and the 10 most recent failures with failed_step.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const statuses = (await query(
      `SELECT status, count(*)::int AS c
       FROM restore_runs
       WHERE started_at >= now() - interval '30 days'
       GROUP BY status`
    )).rows;
    const byStatus = Object.fromEntries(statuses.map((r) => [r.status, r.c]));
    const totalRuns = statuses.reduce((s, r) => s + r.c, 0);
    const avgDuration = (await query(
      `SELECT avg(duration_ms)::bigint AS avg_ms
       FROM restore_runs
       WHERE status = 'success' AND duration_ms IS NOT NULL
         AND started_at >= now() - interval '30 days'`
    )).rows[0].avg_ms;

    // per-step averages aggregated in JS from the steps JSONB ([{step, ms}])
    const stepRows = (await query(
      `SELECT steps FROM restore_runs
       WHERE status = 'success' AND steps IS NOT NULL
         AND started_at >= now() - interval '30 days'`
    )).rows;
    const stepAgg = new Map();
    for (const { steps } of stepRows) {
      if (!Array.isArray(steps)) continue;
      for (const s of steps) {
        const name = String(s?.step || '').slice(0, 128);
        if (!name) continue;
        if (!stepAgg.has(name)) stepAgg.set(name, { sum: 0, n: 0 });
        const a = stepAgg.get(name);
        a.sum += Number(s?.ms) || 0;
        a.n += 1;
      }
    }
    const avgStepMs = [...stepAgg.entries()]
      .map(([step, a]) => ({ step, samples: a.n, avg_ms: Math.round(a.sum / a.n) }))
      .sort((x, y) => y.avg_ms - x.avg_ms);

    const recentFailures = (await query(
      `SELECT r.id, r.user_id, u.email AS user_email, r.started_at, r.completed_at,
              r.failed_step, r.duration_ms
       FROM restore_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.status = 'failed'
       ORDER BY r.started_at DESC LIMIT 10`
    )).rows;

    res.json({
      windowDays: 30,
      totalRuns,
      succeeded: byStatus.success || 0,
      failed: byStatus.failed || 0,
      inProgress: byStatus.in_progress || 0,
      avgSuccessDurationMs: avgDuration == null ? null : Number(avgDuration),
      avgStepMs,
      recentFailures,
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'GET', path: '/storage/photos', category: 'Health',
  description: 'Progress-photo storage usage from backup_progress_photos metadata. Byte sizes are NOT stored (files live on disk via storageService); returns row counts + created_at span with bytes=null.',
  allowedRoles: ['support', 'super_admin', 'read_only', 'analyst'],
}, async (req, res) => {
  try {
    const stats = (await query(
      `SELECT count(*)::int AS total_photos,
              count(DISTINCT user_id)::int AS users_with_photos,
              min(created_at) AS earliest_upload,
              max(created_at) AS latest_upload,
              count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS uploads_last_7d
       FROM backup_progress_photos`
    )).rows[0];
    res.json({
      ...stats,
      total_bytes: null,
      note: 'File sizes are not tracked: backup_progress_photos stores only storage_key metadata and files live on disk under uploads/progress-photos/ via storageService.js. Add a byte-size column at upload time to enable real storage metrics.',
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('support', 'super_admin', 'read_only', 'analyst'));

registerRoute(router, {
  method: 'POST', path: '/sync/retry-failed', category: 'Health',
  description: "Nudge users with failing sync items (last 7d) to open the app and retry. IMPORTANT: there is NO server-side retry — device queues live in SQLite on-device, so actual retries happen on-device when the app next syncs; this only sends a 'sync_retry_nudge' notification. Body {dryRun:true} returns the affected-user count without writing. Audited.",
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    const dryRun = !!(req.body || {}).dryRun;
    const affected = (await query(
      `SELECT DISTINCT s.user_id, u.email
       FROM sync_status_reports s JOIN users u ON u.id = s.user_id
       WHERE s.failing_items IS NOT NULL
         AND s.reported_at >= now() - interval '7 days'`
    )).rows;
    if (dryRun) {
      return res.json({ dryRun: true, affectedUsers: affected.length });
    }
    let sent = 0;
    let failed = 0;
    for (const { user_id: userId } of affected) {
      try {
        await notifications.createNotification({
          recipientId: userId,
          actorId: null,
          type: 'sync_retry_nudge',
          title: 'Sync needs your attention',
          body: 'Some of your data could not be synced. Open the app while online to retry syncing automatically.',
          deepLinkRef: null,
        });
        sent++;
      } catch {
        // per-user failure (e.g. type not yet allow-listed) never blocks others
        failed++;
      }
    }
    await writeAudit(req.admin, 'retry_failed_sync_nudge', 'notifications', null,
      null, { affectedUsers: affected.length, sent, failed, dryRun });
    res.json({
      ok: true,
      affectedUsers: affected.length,
      nudgesSent: sent,
      nudgesFailed: failed,
      note: 'Actual retries happen on-device when each user next opens the app and syncs.',
    });
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

registerRoute(router, {
  method: 'POST', path: '/pr-backfill/run', category: 'Health',
  description: 'Intentionally unimplemented: personal-record backfill runs on-device during sync; no server-side job exists, so this returns 501 rather than faking one.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  res.status(501).json({ error: 'PR backfill runs on-device; no server-side job exists' });
});

module.exports = { router };
