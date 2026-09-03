-- 052: Gym workout management (Phase 11).
--
-- OWNERSHIP: gym_workouts belong to the GYM — distinct from personal user
-- workouts (client_workout_plans / backup_*) and from trainer-owned
-- templates (trainer_workout_templates). The three systems coexist.
--
-- EXERCISES ARE STORED BY NAME (sets/reps/duration as plain data), matching
-- the backup-table convention: local exercise ids are not portable, and a
-- catalog exercise being deleted/archived can never break a gym workout.
--
-- VERSIONING: gym_workouts.version increments on every CONTENT edit.
-- Member saves (gym_workout_saves) store a full JSONB SNAPSHOT + the
-- saved_version — a member's personal copy is independent of the gym
-- original and stays at their saved version until they explicitly update.
--
-- DISTRIBUTION: direct assignments (gym_workout_assignments) reference
-- gym_members, so a member with app_user_id = NULL can hold assignments
-- that become visible the moment an app account is linked. A PUBLISHED
-- workout flagged `recommended` appears for ALL eligible app-connected
-- members of the gym (general recommendation).

CREATE TABLE IF NOT EXISTS gym_workouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  difficulty TEXT NOT NULL DEFAULT 'beginner'
    CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  goal TEXT NOT NULL DEFAULT 'general'
    CHECK (goal IN ('strength', 'fat_loss', 'endurance', 'mobility', 'general')),
  estimated_duration_minutes INTEGER,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  recommended BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_workouts_gym_status
  ON gym_workouts (gym_id, status);

CREATE TABLE IF NOT EXISTS gym_workout_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_id UUID NOT NULL REFERENCES gym_workouts(id) ON DELETE CASCADE,
  exercise_name TEXT NOT NULL,
  sets INTEGER,
  reps TEXT,                    -- "8-12", "12", "AMRAP"…
  duration_minutes INTEGER,
  order_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_gym_workout_exercises_workout
  ON gym_workout_exercises (workout_id, order_index);

CREATE TABLE IF NOT EXISTS gym_workout_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  workout_id UUID NOT NULL REFERENCES gym_workouts(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  end_reason TEXT,
  assigned_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workout_id, member_id, status)
);

CREATE INDEX IF NOT EXISTS idx_gym_workout_assignments_member
  ON gym_workout_assignments (member_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_workout_assignments_gym
  ON gym_workout_assignments (gym_id, status);

CREATE TABLE IF NOT EXISTS gym_workout_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  workout_id UUID NOT NULL REFERENCES gym_workouts(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  saved_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,      -- full independent copy at save time
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workout_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_gym_workout_saves_member
  ON gym_workout_saves (member_id);
