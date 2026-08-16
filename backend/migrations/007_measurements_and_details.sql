-- 007: measurement sync + per-set drill-down detail
CREATE TABLE IF NOT EXISTS measurement_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES users(id) NOT NULL,
  date DATE NOT NULL,
  metric_type TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, date, metric_type)
);

CREATE INDEX IF NOT EXISTS idx_measurement_entries_client_type_date
  ON measurement_entries(client_id, metric_type, date);

-- Per-set drill-down, additive to session_summaries. sets JSONB is
-- STRUCTURAL only (weight/reps/set_type/completed) — RPE and notes stay
-- device-local and are never synced here.
CREATE TABLE IF NOT EXISTS session_exercise_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_summary_id UUID REFERENCES session_summaries(id) NOT NULL,
  exercise_name TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  sets JSONB NOT NULL,
  UNIQUE(session_summary_id, exercise_name, order_index)
);

CREATE INDEX IF NOT EXISTS idx_session_exercise_details_summary
  ON session_exercise_details(session_summary_id);
