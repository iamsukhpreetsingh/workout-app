-- 054: Unified gym content assignments & recommendations (Phase 13).
--
-- ONE table for direct assignments of ALL gym-owned content
-- (content_type WORKOUT | NUTRITION), replacing the per-domain tables
-- gym_workout_assignments (Phase 11) and gym_nutrition_assignments
-- (Phase 12). Existing rows are migrated below; the old tables are dropped.
--
-- WHAT UNIFIES:
--   content_type   discriminator; exactly one of workout_id / item_id is set
--                  (enforced by CHECK), both FK ON DELETE CASCADE — a
--   (hard-)deleted content row removes its assignments with it. Gym content
--   is normally only ever ARCHIVED, not deleted: archived content keeps its
--   assignment rows but is never newly assignable and stops appearing on the
--   member's device (the row is retained so archiving is reversible).
--   starts_on      DATE (inclusive, default = today in the GYM's timezone,
--                  applied by the data layer). A future start = SCHEDULED.
--   ends_on        optional DATE (inclusive). Once ends_on < today the
--   assignment is EXPIRED — computed at read time (effective_status), no cron.
--   notes          free text for the trainer's instruction ("Start with 3
--                  sessions/week.").
--   assigned_version  the content version when assigned — lists expose
--                  content_updated = current version > assigned_version.
--
-- DUPLICATES: at most ONE non-expired ACTIVE assignment per
-- (member, content) — enforced by a partial unique index on physical
-- status='ACTIVE' plus in-code window classification: assigning over an
-- in-window or future ACTIVE row is 409; assigning over an EXPIRED (past
-- end date, still physically ACTIVE) row supersedes it (ended as
-- 'superseded') and inserts the new row. ENDED history rows are unlimited
-- (the old UNIQUE(workout, member, status) could not survive a second
-- assign→end cycle — that defect does not carry over).
--
-- NON-APP MEMBERS: member_id references gym_members, app_user_id NULL fully
-- valid — assignments are stored and become visible the moment an app
-- account is linked (link-app / invite accept).
--
-- RECOMMENDATIONS (general distribution) stay where they are: the
-- `recommended` flag on gym_workouts / gym_nutrition_items, served to
-- eligible app-connected members (ACTIVE membership term) by the /gym/my
-- aggregation — the unified member endpoint is GET /gym/my/content.
--
-- DRIFT TOLERANCE: a database that once half-ran this file outside this
-- transactional runner (statement-by-statement tooling, an earlier draft,
-- a crashed non-transactional session) can hold a PARTIAL
-- gym_content_assignments table. This migration heals such states instead
-- of failing on them: missing columns are added right after CREATE, and
-- the Phase 11/12 backfills run ONLY when the old tables still exist in
-- their exact Phase 11/12 shape — otherwise they are skipped and the old
-- tables are left untouched (zero data loss; the copy can be done
-- manually once the drifted shape is reconciled).

CREATE TABLE IF NOT EXISTS gym_content_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('WORKOUT', 'NUTRITION')),
  workout_id UUID NULL REFERENCES gym_workouts(id) ON DELETE CASCADE,
  item_id UUID NULL REFERENCES gym_nutrition_items(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ends_on DATE NULL,
  notes TEXT,
  assigned_version INTEGER NOT NULL DEFAULT 1 CHECK (assigned_version >= 1),
  end_reason TEXT,
  ended_on DATE NULL,
  assigned_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- exactly one content pointer, matching the discriminator
  CHECK (
    (content_type = 'WORKOUT' AND workout_id IS NOT NULL AND item_id IS NULL) OR
    (content_type = 'NUTRITION' AND item_id IS NOT NULL AND workout_id IS NULL)
  ),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- ── heal partial/drifted states of this table (every clause is a no-op on
-- a fresh run, where CREATE TABLE above already built the full shape) ────
-- Added columns are nullable: pre-existing rows cannot be safely given
-- NOT NULL values at DDL time. The data layer treats every field except
-- ids/gym scoping as optional on read, so this does not affect behavior.
ALTER TABLE gym_content_assignments
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS gym_id UUID REFERENCES gyms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS workout_id UUID REFERENCES gym_workouts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES gym_nutrition_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES gym_members(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS starts_on DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS ends_on DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS assigned_version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS end_reason TEXT,
  ADD COLUMN IF NOT EXISTS ended_on DATE,
  ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_gym
  ON gym_content_assignments (gym_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_member
  ON gym_content_assignments (member_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_workout
  ON gym_content_assignments (workout_id) WHERE workout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_item
  ON gym_content_assignments (item_id) WHERE item_id IS NOT NULL;

-- one non-expired ACTIVE assignment per (member, content); COALESCE keeps
-- the NULL side of the discriminator from making every row distinct
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_content_assignments_one_active
  ON gym_content_assignments (
    member_id, content_type,
    COALESCE(workout_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(item_id,   '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'ACTIVE';

-- ── migrate Phase 11/12 rows into the unified table ─────────────────────
-- GUARDED backfills: each copy runs only when the source table still
-- exists in its exact Phase 11/12 shape (all 8 source columns) and the
-- content table exposes id + version. On a pristine database both guards
-- pass, rows are copied and the per-domain tables are dropped — fully
-- replaced, no dual writes, no drift. On a drifted database the copy is
-- SKIPPED and the old table is kept as-is so nothing is silently lost.
-- ON CONFLICT DO NOTHING defends the copy against junk rows left by a
-- partial earlier run (on a pristine target it never fires).
DO $migrate_workout_rows$
DECLARE matched integer;
BEGIN
  SELECT COUNT(*) INTO matched
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND ((table_name = 'gym_workout_assignments' AND column_name IN
          ('gym_id', 'workout_id', 'member_id', 'status', 'end_reason',
           'assigned_by', 'created_at', 'updated_at'))
      OR (table_name = 'gym_workouts' AND column_name IN ('id', 'version')));
  IF matched = 10 THEN
    INSERT INTO gym_content_assignments
      (gym_id, content_type, workout_id, item_id, member_id, status,
       end_reason, assigned_by, created_at, updated_at, assigned_version)
    SELECT a.gym_id, 'WORKOUT', a.workout_id, NULL, a.member_id, a.status,
           a.end_reason, a.assigned_by, a.created_at, a.updated_at, w.version
    FROM gym_workout_assignments a
    JOIN gym_workouts w ON w.id = a.workout_id
    ON CONFLICT DO NOTHING;
    DROP TABLE gym_workout_assignments;
  END IF;
END
$migrate_workout_rows$;

DO $migrate_nutrition_rows$
DECLARE matched integer;
BEGIN
  SELECT COUNT(*) INTO matched
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND ((table_name = 'gym_nutrition_assignments' AND column_name IN
          ('gym_id', 'item_id', 'member_id', 'status', 'end_reason',
           'assigned_by', 'created_at', 'updated_at'))
      OR (table_name = 'gym_nutrition_items' AND column_name IN ('id', 'version')));
  IF matched = 10 THEN
    INSERT INTO gym_content_assignments
      (gym_id, content_type, workout_id, item_id, member_id, status,
       end_reason, assigned_by, created_at, updated_at, assigned_version)
    SELECT a.gym_id, 'NUTRITION', NULL, a.item_id, a.member_id, a.status,
           a.end_reason, a.assigned_by, a.created_at, a.updated_at, n.version
    FROM gym_nutrition_assignments a
    JOIN gym_nutrition_items n ON n.id = a.item_id
    ON CONFLICT DO NOTHING;
    DROP TABLE gym_nutrition_assignments;
  END IF;
END
$migrate_nutrition_rows$;
