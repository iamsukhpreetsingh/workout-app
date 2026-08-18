-- 021: unified tagging across content types.
--
-- THREE distinct tag models (documented in README):
--  1. Workouts: trainer tags REUSABLE workout_templates; the tags are
--     snapshotted onto assigned_plans at assign time (template-cascade).
--  2. Diet: tags live at the RECIPE level (meal_catalog_items.tags, already
--     existing). diet_plan_meal_items.tags snapshots the recipe's tags at
--     attach time; a plan's displayed tags are the UNION of its items'
--     tags (computed server-side on list). Self-authored client diet plans
--     use plan-level tags directly (they have no catalog layer).
--  3. Supplements: no reusable catalog — plan-level tags set directly on
--     supplement_plans (by the trainer via PATCH, or by the client when
--     self-authoring).

ALTER TABLE diet_plans
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE supplement_plans
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE assigned_plans
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE diet_plan_meal_items
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
