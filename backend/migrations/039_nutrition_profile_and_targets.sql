-- 039: nutrition & dietary profile + versioned active nutrition targets.
--
-- TWO additive changes, extending (never duplicating) existing structures:
--
-- 1. client_intake_profiles gains the fields the recommendation actually
--    uses plus the dietary-context fields that improve trainer decisions.
--    The existing allergen columns and their completed_at gate are
--    untouched. ONE profile per client, shared across trainers — unchanged.
--
-- 2. user_nutrition_targets — the ACTIVE nutrition target, versioned.
--    Target changes NEVER update rows in place: every change opens a new
--    version with an effective_from date, so historical food diaries keep
--    evaluating against the targets that were in force on their date
--    (resolution: latest effective_from <= date). target_source records
--    WHERE the numbers came from:
--      'automatic'        — calculated by the app from the profile
--      'trainer_override' — set explicitly by the trainer (the app's
--                           recommendation is retained in
--                           recommended_snapshot for reference, along with
--                           the trainer's optional reason in override_note)
--    A profile change never silently overwrites a trainer_override — the
--    service layer only opens automatic versions when the latest version is
--    automatic (or none exists).

ALTER TABLE client_intake_profiles
  ADD COLUMN IF NOT EXISTS age INTEGER,
  ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('male','female','other')),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC,
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC,
  ADD COLUMN IF NOT EXISTS target_weight_kg NUMERIC,
  ADD COLUMN IF NOT EXISTS activity_level TEXT
    CHECK (activity_level IN ('sedentary','light','moderate','very','extreme')),
  ADD COLUMN IF NOT EXISTS primary_goal TEXT
    CHECK (primary_goal IN ('weight_loss','weight_maintenance','muscle_gain','recomposition','general_fitness')),
  ADD COLUMN IF NOT EXISTS goal_intensity TEXT
    CHECK (goal_intensity IN ('mild','standard','aggressive')),
  ADD COLUMN IF NOT EXISTS dietary_pattern TEXT,
  ADD COLUMN IF NOT EXISTS food_preferences TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS foods_avoided TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS user_nutrition_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  calories INTEGER NOT NULL,
  protein_g NUMERIC NOT NULL,
  carbs_g NUMERIC NOT NULL,
  fat_g NUMERIC NOT NULL,
  target_source TEXT NOT NULL CHECK (target_source IN ('automatic','trainer_override')),
  override_note TEXT,
  recommended_snapshot JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_user_nutrition_targets_user
  ON user_nutrition_targets(user_id, effective_from DESC);
