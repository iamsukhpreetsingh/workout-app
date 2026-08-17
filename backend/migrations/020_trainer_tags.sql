-- 020: trainer custom tags system
-- Tags table for trainers to create custom tags for workouts and recipes
CREATE TABLE IF NOT EXISTS trainer_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('workout', 'recipe')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, name, category)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_trainer_tags_trainer_category ON trainer_tags(trainer_id, category);

-- Seed default workout tags function
CREATE OR REPLACE FUNCTION seed_default_workout_tags(trainer_uuid UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO trainer_tags (trainer_id, name, category, is_default)
  SELECT trainer_uuid, tag, 'workout', true
  FROM unnest(ARRAY['Push', 'Pull', 'Legs', 'Full Body', 'Upper Body', 'Lower Body', 'Cardio', 'Strength', 'Beginner', 'Hypertrophy', 'Conditioning']) AS tag
  ON CONFLICT (trainer_id, name, category) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Seed default recipe tags function
CREATE OR REPLACE FUNCTION seed_default_recipe_tags(trainer_uuid UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO trainer_tags (trainer_id, name, category, is_default)
  SELECT trainer_uuid, tag, 'recipe', true
  FROM unnest(ARRAY['Vegetarian', 'Vegan', 'Non-Veg', 'High-Protein', 'Low-Carb', 'Dairy-Free', 'Gluten-Free', 'Keto']) AS tag
  ON CONFLICT (trainer_id, name, category) DO NOTHING;
END;
$$ LANGUAGE plpgsql;