-- 042: backup storage for self-authored diet plan VERSIONS.
--
-- Plan versions (migration: local v38 / the versioning model) are the
-- historical target snapshots that keep past diaries evaluating against the
-- targets effective on THEIR date. They previously lived ONLY on the device,
-- so a reinstall silently re-evaluated all history against the CURRENT plan
-- targets. They now ride the diet-plan backup payload and are restored with
-- the plan. Version local ids are the device's numeric version-row ids —
-- stable across syncs, and food_log_entries reference them by this id.

CREATE TABLE IF NOT EXISTS backup_diet_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_entity_id TEXT NOT NULL,
  diet_plan_local_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  daily_calorie_target INTEGER,
  daily_protein_target INTEGER,
  daily_carbs_target INTEGER,
  daily_fat_target INTEGER,
  tolerance_pct INTEGER,
  tracking_mode TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, diet_plan_local_id)
    REFERENCES backup_diet_plans(user_id, local_entity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_backup_diet_plan_versions_plan
  ON backup_diet_plan_versions(user_id, diet_plan_local_id, version_number);
