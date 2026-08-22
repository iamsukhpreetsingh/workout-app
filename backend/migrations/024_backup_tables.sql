-- 024: full-fidelity backup tables (System 3) + user_recipes (real feature table).
--
-- DESIGN NOTES (do not "fix" these later without reading the sync spec):
--  * client_workout_plans and measurement_entries are REUSED as the backup
--    targets for routines and body metrics — they already have correct
--    per-user upsert semantics; duplicating them would create drift.
--  * backup_sessions/... is a NEW full-fidelity store, deliberately separate
--    from the redacted trainer-facing session_summaries/session_exercise_details.
--    The two systems must never be merged or weakened.
--  * Exercise references are stored BY NAME everywhere — local exercise ids
--    are not portable across devices.
--  * Parent→child linkage uses the parent's local_entity_id (TEXT).
--  * Conflict policy: last-write-wins on server-received timestamp
--    (documented simplification, not an oversight).
--  * All deletes against these tables are idempotent by convention.

CREATE TABLE IF NOT EXISTS backup_custom_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  muscle_group TEXT NOT NULL,
  instructions TEXT,
  thumbnail_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

-- Full-fidelity workout history: RPE, per-exercise notes, session notes,
-- superset groupings — everything the redacted trainer sync strips.
CREATE TABLE IF NOT EXISTS backup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  notes TEXT,
  plan_local_id TEXT,
  source_assigned_plan_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_backup_sessions_user_time
  ON backup_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS backup_session_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  session_local_id TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  muscle_group TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  rest_seconds INTEGER,
  group_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, session_local_id)
    REFERENCES backup_sessions(user_id, local_entity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_backup_session_exercises_parent
  ON backup_session_exercises(user_id, session_local_id);

CREATE TABLE IF NOT EXISTS backup_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  session_exercise_local_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  set_type TEXT NOT NULL DEFAULT 'working',
  rpe REAL,
  completed BOOLEAN NOT NULL DEFAULT true,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, session_exercise_local_id)
    REFERENCES backup_session_exercises(user_id, local_entity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_backup_sets_parent
  ON backup_sets(user_id, session_exercise_local_id);

-- Self-authored diet plans: nested day → meal → item, mirroring the local
-- structure exactly. Items reference a user_recipe by ITS local id, or
-- carry their own snapshot fields for custom entries.
CREATE TABLE IF NOT EXISTS backup_diet_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT,
  tags TEXT[],
  daily_calorie_target INTEGER,
  daily_protein_target INTEGER,
  daily_carbs_target INTEGER,
  daily_fat_target INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

CREATE TABLE IF NOT EXISTS backup_diet_plan_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  diet_plan_local_id TEXT NOT NULL,
  day_label TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, diet_plan_local_id)
    REFERENCES backup_diet_plans(user_id, local_entity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backup_diet_plan_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  diet_day_local_id TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  slot_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, diet_day_local_id)
    REFERENCES backup_diet_plan_days(user_id, local_entity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backup_diet_plan_meal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  diet_meal_local_id TEXT NOT NULL,
  local_recipe_id TEXT,
  name TEXT NOT NULL,
  calories INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  serving_size TEXT,
  recipe_url TEXT,
  quantity_multiplier REAL NOT NULL DEFAULT 1,
  client_note TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  photo_path TEXT,
  ingredients TEXT[] NOT NULL DEFAULT '{}',
  allergens TEXT[] NOT NULL DEFAULT '{}',
  prep_time_minutes INTEGER,
  cook_time_minutes INTEGER,
  difficulty TEXT,
  alternate_servings JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, diet_meal_local_id)
    REFERENCES backup_diet_plan_meals(user_id, local_entity_id) ON DELETE CASCADE
);

-- Check-ins are keyed (plan, date), NOT FK'd to the plan: an orphaned
-- check-in is inert, and deleting a plan removes its check-ins explicitly.
CREATE TABLE IF NOT EXISTS backup_diet_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  diet_plan_local_id TEXT NOT NULL,
  date DATE NOT NULL,
  followed BOOLEAN NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, diet_plan_local_id, date)
);
CREATE INDEX IF NOT EXISTS idx_backup_diet_checkins_plan
  ON backup_diet_checkins(user_id, diet_plan_local_id);

CREATE TABLE IF NOT EXISTS backup_supplement_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

CREATE TABLE IF NOT EXISTS backup_supplement_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  supplement_plan_local_id TEXT NOT NULL,
  supplement_name TEXT NOT NULL,
  dosage TEXT,
  timing TEXT,
  notes TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id),
  FOREIGN KEY (user_id, supplement_plan_local_id)
    REFERENCES backup_supplement_plans(user_id, local_entity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backup_supplement_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  supplement_plan_local_id TEXT NOT NULL,
  date DATE NOT NULL,
  taken BOOLEAN NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, supplement_plan_local_id, date)
);

-- Personal records: backed up as literal rows (decision D2) — preserves the
-- historical "when was this PR achieved" record that recomputation cannot.
CREATE TABLE IF NOT EXISTS backup_personal_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  record_type TEXT NOT NULL,
  value REAL NOT NULL,
  secondary_value REAL,
  achieved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

-- Progress photo metadata; the actual file lives on disk via
-- storageService.js under uploads/progress-photos/<user_id>/<file>.
CREATE TABLE IF NOT EXISTS backup_progress_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  date TEXT NOT NULL,
  angle TEXT,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);

-- user_recipes: a REAL feature table (the client's personal recipe catalog),
-- not a passive backup mirror. Full dish schema so existing My Dishes
-- features survive the move from meal_catalog_items.
CREATE TABLE IF NOT EXISTS user_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  local_entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  prep_notes TEXT,
  calories INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  serving_size TEXT,
  recipe_url TEXT,
  photo_path TEXT,
  ingredients TEXT[] NOT NULL DEFAULT '{}',
  allergens TEXT[] NOT NULL DEFAULT '{}',
  prep_time_minutes INTEGER,
  cook_time_minutes INTEGER,
  difficulty TEXT,
  suggested_meal_types TEXT[] NOT NULL DEFAULT '{}',
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  alternate_servings JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, local_entity_id)
);