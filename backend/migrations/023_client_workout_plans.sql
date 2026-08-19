-- 023: client workout plans sync (offline-first)
-- These are user-created workout plans that sync to the cloud for backup/cross-device.

CREATE TABLE IF NOT EXISTS client_workout_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  local_plan_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT,
  exercises JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id, local_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_client_workout_plans_client ON client_workout_plans(client_id);
