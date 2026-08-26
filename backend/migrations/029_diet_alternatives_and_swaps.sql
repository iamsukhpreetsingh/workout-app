-- 029: diet dish alternatives + date-scoped item swaps.
--
-- TWO mirrored homes exist for a meal item in this system (local SQLite
-- local_diet_plan_meal_items for self-authored plans, diet_plan_meal_items
-- for trainer-assigned plans) and they are deliberately NOT unified — same
-- pattern as migration 028's exercise alternatives.
--
-- SNAPSHOT RULE: alternative macro columns are copied at add time;
-- catalog/recipe ids are kept only as references, never joined for display.
-- Editing the source catalog recipe LATER never retroactively changes an
-- already-configured alternative — consistent with every other
-- catalog-sourced value in this schema.
--
-- DATE-SCOPED SWAPS (do not confuse with session-scoped workout swaps): a
-- diet plan is followed repeatedly day after day, so a swap must be keyed to
-- an exact calendar date ("on Aug 24 I ate X instead of Y"). The plan's own
-- definition and every OTHER day are unaffected. There is NO foreign key on
-- the meal-item reference and original_name is snapshotted: a historical
-- swap is a record of what actually happened and must survive the original
-- item being edited or removed from the current plan structure.

CREATE TABLE IF NOT EXISTS diet_plan_meal_item_alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diet_plan_meal_item_id UUID REFERENCES diet_plan_meal_items(id) ON DELETE CASCADE,
  alternative_name TEXT NOT NULL,
  alternative_calories INTEGER NULL,
  alternative_protein_g NUMERIC NULL,
  alternative_carbs_g NUMERIC NULL,
  alternative_fat_g NUMERIC NULL,
  alternative_catalog_item_id UUID NULL REFERENCES meal_catalog_items(id),
  order_index INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diet_item_alternatives_parent
  ON diet_plan_meal_item_alternatives(diet_plan_meal_item_id);

-- Client swaps, synced up from the device via /user/backup/diet-swaps.
-- Doubles as (a) private backup for SELF-AUTHORED plans (plan_server_id IS
-- NULL) and (b) trainer-visible substitution history for TRAINER-ASSIGNED
-- plans (plan_server_id set). Trainer queries filter on plan_server_id —
-- self-authored swaps are never surfaced to anyone but their owner.
CREATE TABLE IF NOT EXISTS diet_item_swaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  plan_ref TEXT NOT NULL,
  plan_server_id UUID NULL,
  diet_plan_meal_item_ref TEXT NOT NULL,
  swap_date DATE NOT NULL,
  original_name TEXT NOT NULL,
  swapped_name TEXT NOT NULL,
  swapped_calories INTEGER NULL,
  swapped_protein_g NUMERIC NULL,
  swapped_carbs_g NUMERIC NULL,
  swapped_fat_g NUMERIC NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, diet_plan_meal_item_ref, swap_date)
);
CREATE INDEX IF NOT EXISTS idx_diet_item_swaps_plan_server
  ON diet_item_swaps(plan_server_id, swap_date DESC);

-- Self-authored backup payload fidelity: alternatives ride INSIDE each
-- synced meal item (JSONB), keeping the spec's two-table shape while making
-- backup restores lossless.
ALTER TABLE backup_diet_plan_meal_items ADD COLUMN IF NOT EXISTS alternatives JSONB NOT NULL DEFAULT '[]';
