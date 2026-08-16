-- Fix FK constraint on diet_plan_meal_items.catalog_item_id to allow
-- deletion of catalog items (items are snapshots, plan data should remain).

ALTER TABLE diet_plan_meal_items 
  DROP CONSTRAINT IF EXISTS diet_plan_meal_items_catalog_item_id_fkey,
  ADD CONSTRAINT diet_plan_meal_items_catalog_item_id_fkey 
  FOREIGN KEY (catalog_item_id) REFERENCES meal_catalog_items(id) ON DELETE SET NULL;