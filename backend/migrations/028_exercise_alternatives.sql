-- 028: equipment-aware exercise alternatives.
--
-- THREE mirrored locations exist for exercise entries in this system
-- (local SQLite plan_exercises, workout_template_exercises,
-- assigned_plan_exercises) and they are deliberately NOT unified into a
-- single polymorphic table — each parent gets its own alternatives table
-- mirroring the structure, consistent with how the rest of this schema
-- duplicates matching shapes across local SQLite and Postgres.
--
-- Snapshot rule: assigning a template copies the template's CURRENT
-- alternatives into assigned_plan_exercise_alternatives rows. Later edits
-- to the template never retroactively change an existing assignment —
-- identical to the established snapshot behavior for sets/reps/rest.

CREATE TABLE IF NOT EXISTS workout_template_exercise_alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_template_exercise_id UUID REFERENCES workout_template_exercises(id) ON DELETE CASCADE,
  alternative_exercise_name TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assigned_plan_exercise_alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_plan_exercise_id UUID REFERENCES assigned_plan_exercises(id) ON DELETE CASCADE,
  alternative_exercise_name TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

-- Swap provenance on the trainer-facing per-set drill-down: populated only
-- when the client swapped the exercise mid-session; NULL = as planned.
ALTER TABLE session_exercise_details ADD COLUMN IF NOT EXISTS original_exercise_name TEXT NULL;
