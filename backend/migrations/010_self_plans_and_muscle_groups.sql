-- 010: client-authored diet/supplement plans + muscle-group tracking
-- trainer_id becomes nullable so clients can author their own plans.
ALTER TABLE diet_plans ALTER COLUMN trainer_id DROP NOT NULL;
ALTER TABLE supplement_plans ALTER COLUMN trainer_id DROP NOT NULL;

ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'trainer'
  CHECK (created_by IN ('trainer', 'client'));
ALTER TABLE supplement_plans ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'trainer'
  CHECK (created_by IN ('trainer', 'client'));

-- muscle group per synced exercise detail (NULL for untagged custom
-- exercises — handled gracefully, never an error)
ALTER TABLE session_exercise_details ADD COLUMN IF NOT EXISTS muscle_group TEXT NULL;
