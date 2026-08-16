-- 014: user-owned dishes in the same catalog table.
-- meal_catalog_items becomes polymorphic-owned: exactly one of trainer_id /
-- user_id is set. Trainer rows are untouched; user rows power "My Dishes".
ALTER TABLE meal_catalog_items ALTER COLUMN trainer_id DROP NOT NULL;
ALTER TABLE meal_catalog_items ADD COLUMN IF NOT EXISTS user_id UUID NULL REFERENCES users(id);

-- names unique per owner (case-insensitive), independently per owner kind
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dish_name_per_user
  ON meal_catalog_items (user_id, lower(name)) WHERE user_id IS NOT NULL;

-- keep ownership sane: every row must have exactly one owner
ALTER TABLE meal_catalog_items DROP CONSTRAINT IF EXISTS chk_dish_owner;
ALTER TABLE meal_catalog_items
  ADD CONSTRAINT chk_dish_owner
  CHECK ((trainer_id IS NULL) <> (user_id IS NULL));
