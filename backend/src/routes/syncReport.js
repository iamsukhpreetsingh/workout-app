// Sync/restore health reporting endpoints (ADMIN.md Phase 11). The mobile
// sync engine and restore flow post here fire-and-forget — these endpoints
// must NEVER be on a critical path for app functionality. All writes are
// best-effort telemetry: small payloads, hard caps, no side effects.
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { registerRoute } = require('../admin/registry');

const router = express.Router();

const MAX_FAILING_ITEMS = 20;
const MAX_STEP_ENTRIES = 32;

function sanitizeFailingItems(items) {
  if (!Array.isArray(items)) return null;
  return items.slice(0, MAX_FAILING_ITEMS).map((it) => ({
    entity_type: String(it?.entity_type || '').slice(0, 64),
    entity_id: String(it?.entity_id || '').slice(0, 128),
    operation: String(it?.operation || '').slice(0, 16),
    attempts: Number(it?.attempts) || 0,
    error: String(it?.error || it?.last_error || '').slice(0, 500),
  }));
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return null;
  return steps.slice(0, MAX_STEP_ENTRIES).map((s) => ({
    step: String(s?.step || '').slice(0, 128),
    ms: Number(s?.ms) || 0,
  }));
}

// POST /sync/report — periodic queue-health snapshot from the device engine
registerRoute(
  router,
  {
    method: 'POST',
    path: '/report',
    description: 'Device sync-engine posts its queue health (pending/failed counts, failing item sample). Fire-and-forget telemetry.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Sync',
  }, async (req, res) => {
    try {
      const b = req.body || {};
      await query(
        `INSERT INTO sync_status_reports
           (user_id, pending_count, failed_count, queue_by_entity_type, failing_items, app_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user.id,
          Math.max(0, Number(b.pendingCount) || 0),
          Math.max(0, Number(b.failedCount) || 0),
          b.byEntityType ? JSON.stringify(b.byEntityType) : null,
          (() => {
            const items = sanitizeFailingItems(b.failingItems);
            return items ? JSON.stringify(items) : null;
          })(),
          typeof b.appVersion === 'string' ? b.appVersion.slice(0, 64) : null,
        ]
      );
      res.json({ ok: true });
    } catch (e) {
      // telemetry endpoint — never surface as a client-side failure
      res.json({ ok: false });
    }
  }, requireAuth
);

// POST /sync/restore-run/start — opens a restore run row; returns its id
registerRoute(
  router,
  {
    method: 'POST',
    path: '/restore-run/start',
    description: 'Marks the start of a data restore on this account; returns the run id to pass to /sync/restore-run/:runId/finish.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Sync',
  }, async (req, res) => {
    try {
      const { rows } = await query(
        `INSERT INTO restore_runs (user_id) VALUES ($1) RETURNING id`,
        [req.user.id]
      );
      res.status(201).json({ runId: rows[0].id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }, requireAuth
);

// POST /sync/restore-run/:runId/finish — closes a restore run
registerRoute(
  router,
  {
    method: 'POST',
    path: '/restore-run/:runId/finish',
    description: 'Closes a restore run with success/failure, duration, failed step name and per-step timings.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Sync',
  }, async (req, res) => {
    try {
      const status = req.body?.status === 'success' ? 'success' : 'failed';
      const failedStep = typeof req.body?.failedStep === 'string' ? req.body.failedStep.slice(0, 200) : null;
      const steps = sanitizeSteps(req.body?.steps);
      const { rowCount } = await query(
        `UPDATE restore_runs
         SET completed_at = now(),
             status = $2,
             duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
             failed_step = $3,
             steps = $4
         WHERE id::text = $1 AND user_id = $5 AND status = 'in_progress'`,
        [req.params.runId, status, failedStep, steps ? JSON.stringify(steps) : null, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'No open restore run found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }, requireAuth
);

module.exports = router;
