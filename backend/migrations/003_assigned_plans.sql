-- 003: assigned workout plans (trainer → client)
-- exercise_name is plain text: the backend has no visibility into a
-- client's local SQLite exercise IDs (local-first, no sync in this pass).
CREATE TABLE IF NOT EXISTS assigned_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assigned_plans_client ON assigned_plans(client_id);

CREATE TABLE IF NOT EXISTS assigned_plan_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_plan_id UUID NOT NULL REFERENCES assigned_plans(id) ON DELETE CASCADE,
  exercise_name TEXT NOT NULL,
  target_sets INTEGER NOT NULL,
  target_reps TEXT,
  target_weight_note TEXT,
  order_index INTEGER NOT NULL,
  rest_seconds INTEGER,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_assigned_plan_exercises_plan ON assigned_plan_exercises(assigned_plan_id);
