-- 040: log-first nutrition model (the daily food log is the core entity).
--
-- Product model change: the food log is no longer an attachment of a diet
-- plan — it is EVERY food a user logs on a date, full stop. Targets and
-- structure suggestions are optional overlays on top of the log.
--
-- 1. food_log_entries (user-scoped) — the ONE real backing store for every
--    user's diary. No plan_ref, no planned/swapped/extra/free_logged
--    vocabulary: food_source_type records where the food data came from
--    ('global_database','personal_recipe','trainer_recipe','custom_dish',
--    'manual'). suggested_by_trainer is purely informational metadata.
--    The prior plan-scoped backup_food_log_entries is migrated by
--    scripts/migrateDietToLogFirst.js (Phase 8) and then treated as legacy.
--
-- 2. global_foods — shared curated + external food database (Phase 2):
--    seed data ships in the table; Open Food Facts lookups are CACHED here
--    (verified=false) so the database grows organically from real usage;
--    admins add/edit/verify entries via the admin Foods module. cuisine_tags
--    is searchability-only metadata — never a scoping restriction.
--
-- 3. custom_dishes + custom_dish_ingredients — the ingredient-based dish
--    builder (Phase 3). Ingredient macros are SNAPSHOTS at add-time: editing
--    a saved dish never retroactively changes already-logged entries.
--
-- 4. structure_suggestions — advisory meal-shape guidance (Phase 5). Free
--    text + optional recipe pointer; NEVER a requirement, never gates
--    target-status calculation.
--
-- 5. user_nutrition_targets gains target_mode ('daily' | 'weekly_average'
--    — the latter evaluates the trailing 7-day mean, not each day) and
--    set_by ('self'|'trainer'); the source CHECK is widened to allow 'self'
--    (users setting their own targets without a trainer). Versioning rules
--    from migration 039 are unchanged.

CREATE TABLE IF NOT EXISTS food_log_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_entity_id TEXT NOT NULL,
  log_date DATE NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'other'
    CHECK (meal_type IN ('breakfast','lunch','dinner','snack','other')),
  name TEXT NOT NULL,
  calories INTEGER,
  protein_g NUMERIC,
  carbs_g NUMERIC,
  fat_g NUMERIC,
  fiber_g NUMERIC,
  sugar_g NUMERIC,
  sodium_mg NUMERIC,
  quantity NUMERIC NOT NULL DEFAULT 1,
  serving_unit TEXT NOT NULL DEFAULT 'serving',
  food_source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (food_source_type IN ('global_database','personal_recipe','trainer_recipe','custom_dish','manual')),
  food_source_id TEXT,
  suggested_by_trainer BOOLEAN NOT NULL DEFAULT false,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_food_log_entries_user_date
  ON food_log_entries(user_id, log_date);

CREATE TABLE IF NOT EXISTS global_foods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  brand TEXT,
  calories INTEGER,
  protein_g NUMERIC,
  carbs_g NUMERIC,
  fat_g NUMERIC,
  fiber_g NUMERIC,
  sugar_g NUMERIC,
  sodium_mg NUMERIC,
  default_serving_size NUMERIC,
  default_serving_unit TEXT DEFAULT 'serving',
  source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','open_food_facts','admin_added')),
  barcode TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  cuisine_tags TEXT[] NOT NULL DEFAULT '{}',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_foods_name ON global_foods(lower(name));
CREATE INDEX IF NOT EXISTS idx_global_foods_barcode ON global_foods(barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS custom_dishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  total_servings NUMERIC NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

CREATE TABLE IF NOT EXISTS custom_dish_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_dish_id UUID NOT NULL REFERENCES custom_dishes(id) ON DELETE CASCADE,
  global_food_id UUID NULL REFERENCES global_foods(id) ON DELETE SET NULL,
  ingredient_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit TEXT NOT NULL DEFAULT 'g',
  calories_snapshot NUMERIC NOT NULL DEFAULT 0,
  protein_g_snapshot NUMERIC NOT NULL DEFAULT 0,
  carbs_g_snapshot NUMERIC NOT NULL DEFAULT 0,
  fat_g_snapshot NUMERIC NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_custom_dish_ingredients_dish
  ON custom_dish_ingredients(custom_dish_id, order_index);

CREATE TABLE IF NOT EXISTS structure_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL DEFAULT 'other',
  suggestion_text TEXT NOT NULL,
  suggested_recipe_id UUID NULL,
  created_by UUID REFERENCES users(id),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_structure_suggestions_user
  ON structure_suggestions(user_id, order_index);

ALTER TABLE user_nutrition_targets
  ADD COLUMN IF NOT EXISTS target_mode TEXT NOT NULL DEFAULT 'daily'
    CHECK (target_mode IN ('daily','weekly_average')),
  ADD COLUMN IF NOT EXISTS set_by TEXT;
-- widen target_source to allow user-set targets (drop + re-add the CHECK)
ALTER TABLE user_nutrition_targets DROP CONSTRAINT IF EXISTS user_nutrition_targets_target_source_check;
ALTER TABLE user_nutrition_targets
  ADD CONSTRAINT user_nutrition_targets_target_source_check
    CHECK (target_source IN ('automatic','trainer_override','self'));
