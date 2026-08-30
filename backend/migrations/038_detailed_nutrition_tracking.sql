-- 038: outcome-first nutrition tracking (detailed mode).
--
-- Product model: the plan is a RECOMMENDATION, the food diary is REALITY,
-- the nutrition target is the OUTCOME. Additive only — existing Simple-mode
-- plans/check-ins are untouched (tracking_mode defaults to 'simple').
--
-- 1. tracking_mode + tolerance_pct on both plan homes (diet_plans for
--    trainer-assigned plans, backup_diet_plans for self-authored ones).
--    tolerance_pct is the ±% around the calorie/macro targets that still
--    counts as "on target" (default 10).
--
-- 2. backup_food_log_entries — the raw food diary synced from the device
--    (UNIQUE(user_id, local_entity_id) → idempotent upserts; an offline
--    entry synced twice can never duplicate). source is the four-value
--    model: planned / swapped / extra / free_logged. plan_server_id is set
--    ONLY for trainer-assigned plans and drives trainer monitoring
--    visibility — self-authored diary entries (plan_server_id IS NULL) are
--    never surfaced to anyone but their owner, matching diet_item_swaps.
--    There is deliberately NO daily precomputed adherence column: daily
--    totals/statuses are always DERIVED from the raw entries.
--
-- 3. diet_trainer_notes — lightweight trainer→client notes against a client
--    (optionally a plan and/or date), with a read receipt. Client-visible.

ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS tracking_mode TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS tolerance_pct INTEGER NOT NULL DEFAULT 10;
ALTER TABLE backup_diet_plans ADD COLUMN IF NOT EXISTS tracking_mode TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE backup_diet_plans ADD COLUMN IF NOT EXISTS tolerance_pct INTEGER NOT NULL DEFAULT 10;

CREATE TABLE IF NOT EXISTS backup_food_log_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  plan_ref TEXT,
  plan_server_id UUID NULL,
  plan_version_id INTEGER NULL,
  log_date DATE NOT NULL,
  meal_type TEXT,
  source TEXT NOT NULL CHECK (source IN ('planned','swapped','extra','free_logged')),
  planned_item_ref TEXT,
  name TEXT NOT NULL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  serving_size TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_backup_food_log_user_date
  ON backup_food_log_entries(user_id, log_date);
CREATE INDEX IF NOT EXISTS idx_backup_food_log_plan_date
  ON backup_food_log_entries(user_id, plan_ref, log_date);
-- trainer monitoring reads: which clients, which days, which plan
CREATE INDEX IF NOT EXISTS idx_backup_food_log_server_plan
  ON backup_food_log_entries(plan_server_id, log_date);

CREATE TABLE IF NOT EXISTS diet_trainer_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES users(id),
  plan_id UUID NULL REFERENCES diet_plans(id) ON DELETE SET NULL,
  note_date DATE NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_diet_trainer_notes_client
  ON diet_trainer_notes(client_id, created_at DESC);
