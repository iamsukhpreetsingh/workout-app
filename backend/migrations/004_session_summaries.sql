-- 004: aggregate-only session summaries (client → backend sync target)
-- Deliberately aggregate-only: no per-set detail, no RPE, no notes, no photos.
-- That data stays device-local in this phase.
CREATE TABLE IF NOT EXISTS session_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES users(id) NOT NULL,
  local_session_id TEXT NOT NULL,
  name TEXT,
  performed_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER,
  exercise_count INTEGER NOT NULL DEFAULT 0,
  working_set_count INTEGER NOT NULL DEFAULT 0,
  total_volume NUMERIC NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, local_session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_client_time
  ON session_summaries(client_id, performed_at DESC);
