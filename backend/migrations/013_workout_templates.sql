-- 013: reusable workout templates (trainer-owned library)
-- Mirrors assigned_plans/assigned_plan_exercises field-for-field so
-- assigning a template is a straight snapshot copy, not a transformation.
CREATE TABLE IF NOT EXISTS workout_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  notes TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workout_template_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_template_id UUID NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
  exercise_name TEXT NOT NULL,
  target_sets INTEGER NOT NULL,
  target_reps TEXT,
  target_weight_note TEXT,
  order_index INTEGER NOT NULL,
  rest_seconds INTEGER,
  notes TEXT,
  group_id TEXT
);

-- traceability only: which template an assignment originated from. Never
-- used for live lookups or syncing — assignments are independent snapshots.
ALTER TABLE assigned_plans ADD COLUMN IF NOT EXISTS source_template_id UUID NULL
  REFERENCES workout_templates(id);
