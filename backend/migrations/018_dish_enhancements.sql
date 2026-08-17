-- 018: richer dish metadata for the meal catalog (trainer + user-owned),
-- with the client-relevant fields ALSO snapshotted into diet plan items.

ALTER TABLE meal_catalog_items
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS ingredients TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allergens TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prep_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS cook_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS difficulty TEXT
    CHECK (difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard')),
  ADD COLUMN IF NOT EXISTS suggested_meal_types TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alternate_servings JSONB NOT NULL DEFAULT '[]';

-- snapshot columns: photo, allergens, ingredients, timing/difficulty and
-- alternate servings matter to the CLIENT viewing their chart — preserved
-- at insert time, immune to later catalog edits (same rule as macros).
-- suggested_meal_types / is_favorite are trainer-organizational only and
-- deliberately NOT snapshotted.
ALTER TABLE diet_plan_meal_items
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS ingredients TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allergens TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prep_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS cook_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS difficulty TEXT,
  ADD COLUMN IF NOT EXISTS alternate_servings JSONB NOT NULL DEFAULT '[]';
