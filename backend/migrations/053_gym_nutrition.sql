-- 053: Gym nutrition & diet management (Phase 12).
--
-- OWNERSHIP: gym_nutrition_items belong to the GYM — separate from user
-- diet plans (diet_plans / backup_diet_plans) and trainer-owned recipes
-- (meal_catalog_items / user_recipes). The systems coexist untouched.
--
-- KINDS: RECIPE (entries = ingredients/steps), MEAL_PLAN (entries =
-- per-day guidance), DIET_RECOMMENDATION (entries = guideline lines).
-- Uniform `content.entries` shape keeps the web editor and the mobile
-- rendering simple; optional `targets` (calories/macros) attaches the
-- nutrition targets to any item.
--
-- VERSIONING + SNAPSHOT SAVES mirror Phase 11 exactly: `version` bumps on
-- content edits; gym_nutrition_saves stores a full JSONB snapshot at the
-- member's saved version — gym edits never silently change a personal copy.
--
-- DISTRIBUTION: direct assignments reference gym_members (app_user_id NULL
-- fully valid, stored until the member connects); a PUBLISHED item flagged
-- `recommended` is visible to all eligible app-connected members.

CREATE TABLE IF NOT EXISTS gym_nutrition_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('RECIPE', 'MEAL_PLAN', 'DIET_RECOMMENDATION')),
  title TEXT NOT NULL,
  description TEXT,
  content JSONB NOT NULL DEFAULT '{"entries": []}',
  targets JSONB,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  recommended BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_nutrition_items_gym
  ON gym_nutrition_items (gym_id, status);

CREATE TABLE IF NOT EXISTS gym_nutrition_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES gym_nutrition_items(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  end_reason TEXT,
  assigned_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, member_id, status)
);

CREATE INDEX IF NOT EXISTS idx_gym_nutrition_assignments_member
  ON gym_nutrition_assignments (member_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_nutrition_assignments_gym
  ON gym_nutrition_assignments (gym_id, status);

CREATE TABLE IF NOT EXISTS gym_nutrition_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES gym_nutrition_items(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  saved_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_gym_nutrition_saves_member
  ON gym_nutrition_saves (member_id);
