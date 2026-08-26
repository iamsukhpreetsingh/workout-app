-- Global exercise library — the platform-wide official catalog that the
-- admin dashboard (Phase 6) manages and the mobile app can reference.
-- Additive only: nothing in the existing mobile flow reads this table yet;
-- it is seeded from src/seed/exercises_full.json by scripts/seedExercises.js
-- and browsable/editable in the admin Database section via auto-discovery.
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,                -- seed ids like '0001'
  name TEXT NOT NULL,
  category TEXT,
  body_part TEXT,
  equipment TEXT,
  muscle_group TEXT,
  secondary_muscles JSONB,
  target TEXT,
  instructions JSONB,                 -- localized prose: {"en": "..."}
  instruction_steps JSONB,            -- localized step lists: {"en": ["...", ...]}
  image TEXT,
  gif_url TEXT,
  media_id TEXT,
  attribution TEXT,
  is_official BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exercises_name_idx ON exercises (name);
CREATE INDEX IF NOT EXISTS exercises_body_part_idx ON exercises (body_part);
