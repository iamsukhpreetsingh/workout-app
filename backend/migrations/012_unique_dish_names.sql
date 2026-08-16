-- 012: dish names are unique per trainer (case-insensitive).
-- Collapse any pre-existing duplicates first (keep the oldest of each name)
-- so the unique index can be created on existing data.
DELETE FROM meal_catalog_items a
USING meal_catalog_items b
WHERE a.trainer_id = b.trainer_id
  AND lower(a.name) = lower(b.name)
  AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_dish_name_per_trainer
  ON meal_catalog_items (trainer_id, lower(name));
