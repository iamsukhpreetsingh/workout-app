-- 025: one-time data migration — moves CLIENT-OWNED content from the live
-- server-first tables into the backup tables, with synthesized local ids
-- ('mig_<uuid>' prefixes) that the app adopts as its own local ids during
-- restore.
--
-- EDGE CASE (D1, documented so it isn't rediscovered as a bug): a client
-- whose plans existed ONLY server-side (created before the local-first
-- rewire) has no local rows. On their first launch after the upgrade the
-- restore gate runs (restore_completed_at is unset), pulls these migrated
-- rows into the local tables, and MUST mark them synced=true with server_id
-- populated — otherwise the sync engine would treat freshly-restored data
-- as new local edits and re-upload it.
--
-- Trainer-assigned plans (created_by='trainer') are NOT migrated: they stay
-- in diet_plans/supplement_plans as server-truth, cached offline via the
-- cached_* tables. Originals of migrated rows are LEFT IN PLACE (inert
-- post-upgrade; the new app never reads them) for rollback safety — a later
-- cleanup migration may drop them.

-- Client-authored diet plans → backup
INSERT INTO backup_diet_plans
  (id, user_id, local_entity_id, name, notes, tags,
   daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
   created_at, updated_at)
SELECT gen_random_uuid(), dp.client_id, 'mig_' || dp.id, dp.name, dp.notes, dp.tags,
       dp.daily_calorie_target, dp.daily_protein_target, dp.daily_carbs_target, dp.daily_fat_target,
       dp.created_at, now()
FROM diet_plans dp
WHERE dp.created_by = 'client';

INSERT INTO backup_diet_plan_days
  (id, user_id, local_entity_id, diet_plan_local_id, day_label, order_index)
SELECT gen_random_uuid(), dp.client_id, 'migd_' || d.id, 'mig_' || dp.id, d.day_label, d.order_index
FROM diet_plan_days d
JOIN diet_plans dp ON dp.id = d.diet_plan_id
WHERE dp.created_by = 'client';

INSERT INTO backup_diet_plan_meals
  (id, user_id, local_entity_id, diet_day_local_id, meal_type, order_index, slot_note)
SELECT gen_random_uuid(), dp.client_id, 'migm_' || m.id, 'migd_' || d.id, m.meal_type, m.order_index, m.slot_note
FROM diet_plan_meals m
JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
JOIN diet_plans dp ON dp.id = d.diet_plan_id
WHERE dp.created_by = 'client';

INSERT INTO backup_diet_plan_meal_items
  (id, user_id, local_entity_id, diet_meal_local_id, local_recipe_id, name, calories,
   protein_g, carbs_g, fat_g, serving_size, recipe_url, quantity_multiplier, client_note,
   order_index, photo_path, ingredients, allergens, prep_time_minutes, cook_time_minutes,
   difficulty, alternate_servings, tags)
SELECT gen_random_uuid(), dp.client_id, 'migi_' || i.id, 'migm_' || m.id,
       CASE WHEN i.catalog_item_id IS NOT NULL THEN 'mig_' || i.catalog_item_id ELSE NULL END,
       i.name, i.calories, i.protein_g, i.carbs_g, i.fat_g, i.serving_size, i.recipe_url,
       i.quantity_multiplier, i.client_note, i.order_index, i.photo_path, i.ingredients,
       i.allergens, i.prep_time_minutes, i.cook_time_minutes, i.difficulty,
       i.alternate_servings, i.tags
FROM diet_plan_meal_items i
JOIN diet_plan_meals m ON m.id = i.diet_plan_meal_id
JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
JOIN diet_plans dp ON dp.id = d.diet_plan_id
WHERE dp.created_by = 'client';

INSERT INTO backup_diet_checkins
  (id, user_id, diet_plan_local_id, date, followed, note)
SELECT gen_random_uuid(), dp.client_id, 'mig_' || dp.id, c.date, c.followed, c.note
FROM diet_checkins c
JOIN diet_plans dp ON dp.id = c.diet_plan_id
WHERE dp.created_by = 'client';

-- Client-authored supplement plans → backup
INSERT INTO backup_supplement_plans (id, user_id, local_entity_id, name, notes, tags, created_at, updated_at)
SELECT gen_random_uuid(), sp.client_id, 'mig_' || sp.id, sp.name, sp.notes, sp.tags, sp.created_at, now()
FROM supplement_plans sp
WHERE sp.created_by = 'client';

INSERT INTO backup_supplement_plan_items
  (id, user_id, local_entity_id, supplement_plan_local_id, supplement_name, dosage, timing, notes, order_index)
SELECT gen_random_uuid(), sp.client_id, 'migi_' || i.id, 'mig_' || sp.id,
       i.supplement_name, i.dosage, i.timing, i.notes, i.order_index
FROM supplement_plan_items i
JOIN supplement_plans sp ON sp.id = i.supplement_plan_id
WHERE sp.created_by = 'client';

INSERT INTO backup_supplement_checkins (id, user_id, supplement_plan_local_id, date, taken, note)
SELECT gen_random_uuid(), sp.client_id, 'mig_' || sp.id, c.date, c.taken, c.note
FROM supplement_checkins c
JOIN supplement_plans sp ON sp.id = c.supplement_plan_id
WHERE sp.created_by = 'client';

-- My Dishes (user-owned meal_catalog_items) → user_recipes.
-- Items in migrated plans reference these via 'mig_' || catalog_item_id.
INSERT INTO user_recipes
  (id, user_id, local_entity_id, name, calories, protein_g, carbs_g, fat_g,
   serving_size, recipe_url, photo_path, ingredients, allergens, prep_time_minutes,
   cook_time_minutes, difficulty, suggested_meal_types, is_favorite,
   alternate_servings, tags, created_at, updated_at)
SELECT gen_random_uuid(), mci.user_id, 'mig_' || mci.id, mci.name, mci.calories,
       mci.protein_g, mci.carbs_g, mci.fat_g, mci.serving_size, mci.recipe_url,
       mci.photo_path, mci.ingredients, mci.allergens, mci.prep_time_minutes,
       mci.cook_time_minutes, mci.difficulty, mci.suggested_meal_types, mci.is_favorite,
       mci.alternate_servings, mci.tags, mci.created_at, now()
FROM meal_catalog_items mci
WHERE mci.user_id IS NOT NULL;