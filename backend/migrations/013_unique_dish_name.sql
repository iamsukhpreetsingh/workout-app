-- Add unique constraint on dish names per trainer
ALTER TABLE meal_catalog_items 
  ADD CONSTRAINT unique_dish_name_per_trainer UNIQUE (trainer_id, name);