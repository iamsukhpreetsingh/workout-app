-- 011: meal catalog + structured day/slot/item diet plans
-- Supplements stay on the flat structure (out of scope this pass).

-- Trainer-owned reusable dish library (not shared across trainers)
CREATE TABLE IF NOT EXISTS meal_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  calories INTEGER,
  protein_g NUMERIC,
  carbs_g NUMERIC,
  fat_g NUMERIC,
  serving_size TEXT,
  recipe_url TEXT,
  prep_notes TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional plan-level daily targets
ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS daily_calorie_target INTEGER NULL;
ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS daily_protein_target NUMERIC NULL;
ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS daily_carbs_target NUMERIC NULL;
ALTER TABLE diet_plans ADD COLUMN IF NOT EXISTS daily_fat_target NUMERIC NULL;

-- Day / meal-slot / item structure (replaces flat diet_plan_items)
CREATE TABLE IF NOT EXISTS diet_plan_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diet_plan_id UUID NOT NULL REFERENCES diet_plans(id) ON DELETE CASCADE,
  day_label TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS diet_plan_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diet_plan_day_id UUID NOT NULL REFERENCES diet_plan_days(id) ON DELETE CASCADE,
  meal_type TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  slot_note TEXT
);

-- Items are SNAPSHOTS: fields are copied from the catalog at insert time;
-- catalog_item_id is kept only as a reference for an explicit later
-- "update from catalog" action, never for live lookups.
CREATE TABLE IF NOT EXISTS diet_plan_meal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diet_plan_meal_id UUID NOT NULL REFERENCES diet_plan_meals(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES meal_catalog_items(id),
  name TEXT NOT NULL,
  calories INTEGER,
  protein_g NUMERIC,
  carbs_g NUMERIC,
  fat_g NUMERIC,
  serving_size TEXT,
  recipe_url TEXT,
  quantity_multiplier NUMERIC NOT NULL DEFAULT 1,
  client_note TEXT,
  order_index INTEGER NOT NULL
);

-- One-time wrap of legacy flat items: each old item becomes one meal slot
-- on a single "Every Day" day (early-stage data; structure was not real).
INSERT INTO diet_plan_days (diet_plan_id, day_label, order_index)
SELECT DISTINCT i.diet_plan_id, 'Every Day', 0
FROM diet_plan_items i
WHERE NOT EXISTS (
  SELECT 1 FROM diet_plan_days d WHERE d.diet_plan_id = i.diet_plan_id
);

INSERT INTO diet_plan_meals (diet_plan_day_id, meal_type, order_index)
SELECT d.id, i.meal_label, i.order_index
FROM diet_plan_items i
JOIN diet_plan_days d ON d.diet_plan_id = i.diet_plan_id AND d.day_label = 'Every Day'
WHERE NOT EXISTS (SELECT 1 FROM diet_plan_meals m WHERE m.diet_plan_day_id = d.id);

INSERT INTO diet_plan_meal_items
  (diet_plan_meal_id, name, calories, protein_g, carbs_g, fat_g, quantity_multiplier, order_index)
SELECT m.id, i.description, NULL, NULL, NULL, NULL, 1, i.order_index
FROM diet_plan_items i
JOIN diet_plan_days d ON d.diet_plan_id = i.diet_plan_id AND d.day_label = 'Every Day'
JOIN diet_plan_meals m ON m.diet_plan_day_id = d.id AND m.order_index = i.order_index
WHERE NOT EXISTS (SELECT 1 FROM diet_plan_meal_items mi WHERE mi.diet_plan_meal_id = m.id);

-- diet_plan_items is deprecated; kept read-only for old clients, no longer written.
