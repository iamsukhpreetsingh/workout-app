-- Server-side sync/restore health instrumentation (ADMIN.md Phase 11).
-- The device-side sync_queue lives in SQLite; these tables capture the
-- server-visible projections the admin dashboard needs:
--   - periodic status reports posted by the mobile sync engine
--   - restore-flow runs (start/finish) for duration/failure monitoring
-- Purely additive: no existing mobile flow reads or depends on them, and
-- reporting endpoints are fire-and-forget on the client.

CREATE TABLE IF NOT EXISTS sync_status_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  queue_by_entity_type JSONB,   -- {sessions: {pending: n, failed: n}, ...}
  failing_items JSONB,          -- capped sample of failed items w/ last_error
  app_version TEXT
);

CREATE INDEX IF NOT EXISTS sync_status_reports_user_idx ON sync_status_reports (user_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS sync_status_reports_time_idx ON sync_status_reports (reported_at DESC);

CREATE TABLE IF NOT EXISTS restore_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'success', 'failed')),
  duration_ms INTEGER,
  failed_step TEXT,
  steps JSONB                    -- [{step, ms}] per-entity-type durations
);

CREATE INDEX IF NOT EXISTS restore_runs_user_idx ON restore_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS restore_runs_time_idx ON restore_runs (started_at DESC);
