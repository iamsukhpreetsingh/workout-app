-- 006: superset grouping for assigned plan exercises (mirrors the mobile
-- app's plan_exercises.group_id)
ALTER TABLE assigned_plan_exercises ADD COLUMN IF NOT EXISTS group_id TEXT NULL;
