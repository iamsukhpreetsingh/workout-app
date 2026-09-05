-- ─────────────────────────────────────────────────────────────────────────────
-- fix-gym-content-assignments-drift.sql
--
-- Repairs a DRIFTED gym_content_assignments table.
--
-- Symptom:  'null value in column "content_id" ... violates not-null constraint'
--           (also previously: content_kind NOT NULL errors)
-- Cause:    an EARLY DRAFT of migration 054 was applied to this database
--           before the final version existed. The draft carried extra columns
--           (content_id NOT NULL, content_kind) that the final schema replaced
--           with the workout_id / item_id discriminator pair. Because the draft
--           was recorded as applied, the final migration's heal never ran.
--           The app's own assignment inserts AND the demo seed both hit this.
--
-- Safe to re-run (every step is idempotent). Nothing is deleted except the
-- two stale draft columns; assignment DATA is never touched.
--
-- Run:  psql "$DATABASE_URL" -f fix-gym-content-assignments-drift.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- \echo '── BEFORE: columns of gym_content_assignments ──'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'gym_content_assignments'
ORDER BY ordinal_position;

-- ── 1. drop the stale draft columns (the actual fix) ────────────────────────
ALTER TABLE gym_content_assignments DROP COLUMN IF EXISTS content_id;
ALTER TABLE gym_content_assignments DROP COLUMN IF EXISTS content_kind;

-- ── 2. ensure every FINAL-schema column exists (mirrors migration 054 heal) ─
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

-- ── 3. primary key on id (a draft may have keyed the table on content_id,
--       which step 1 dropped — dropping a column drops such a PK with it) ───
DO $fix_pk$
DECLARE n_all bigint; n_null bigint; n_distinct bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema() AND table_name = 'gym_content_assignments'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    SELECT COUNT(*) INTO n_all FROM gym_content_assignments;
    SELECT COUNT(*) INTO n_null FROM gym_content_assignments WHERE id IS NULL;
    SELECT COUNT(DISTINCT id) INTO n_distinct FROM gym_content_assignments WHERE id IS NOT NULL;
    IF n_null = 0 AND n_distinct = n_all THEN
      ALTER TABLE gym_content_assignments ADD PRIMARY KEY (id);
      RAISE NOTICE 'primary key added on (id)';
    ELSE
      RAISE NOTICE 'SKIPPED primary key: id has NULLs or duplicates (rows %, nulls %, distinct %)', n_all, n_null, n_distinct;
    END IF;
  END IF;
END
$fix_pk$;

-- ── 4. NOT NULL tightening (only when no violating rows exist) ──────────────
DO $fix_notnull$
DECLARE
  cols text[] := ARRAY['id','gym_id','content_type','member_id','status','starts_on','assigned_version'];
  col text; n bigint;
BEGIN
  FOREACH col IN ARRAY cols LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'gym_content_assignments'
        AND column_name = col AND is_nullable = 'YES'
    ) THEN
      EXECUTE format('SELECT COUNT(*) FROM gym_content_assignments WHERE %I IS NULL', col) INTO n;
      IF n = 0 THEN
        EXECUTE format('ALTER TABLE gym_content_assignments ALTER COLUMN %I SET NOT NULL', col);
        RAISE NOTICE 'NOT NULL enforced on %', col;
      ELSE
        RAISE NOTICE 'SKIPPED NOT NULL on % (% row(s) NULL — clean them first)', col, n;
      END IF;
    END IF;
  END LOOP;
END
$fix_notnull$;

-- ── 5. final CHECK constraints (detect by DEFINITION, not name — inline
--       CHECKs from CREATE TABLE carry auto-generated names) ────────────────
DO $fix_check_ptr$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'gym_content_assignments' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%workout_id IS NOT NULL%'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM gym_content_assignments
      WHERE NOT (
        (content_type = 'WORKOUT' AND workout_id IS NOT NULL AND item_id IS NULL) OR
        (content_type = 'NUTRITION' AND item_id IS NOT NULL AND workout_id IS NULL)
      )
    ) THEN
      ALTER TABLE gym_content_assignments
        ADD CONSTRAINT gym_content_assignments_pointer_check CHECK (
          (content_type = 'WORKOUT' AND workout_id IS NOT NULL AND item_id IS NULL) OR
          (content_type = 'NUTRITION' AND item_id IS NOT NULL AND workout_id IS NULL)
        );
      RAISE NOTICE 'pointer CHECK added';
    ELSE
      RAISE NOTICE 'SKIPPED pointer CHECK: existing rows violate it';
    END IF;
  END IF;
END
$fix_check_ptr$;

DO $fix_check_dates$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'gym_content_assignments' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%ends_on >= starts_on%'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM gym_content_assignments WHERE ends_on IS NOT NULL AND ends_on < starts_on
    ) THEN
      ALTER TABLE gym_content_assignments
        ADD CONSTRAINT gym_content_assignments_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on);
      RAISE NOTICE 'dates CHECK added';
    ELSE
      RAISE NOTICE 'SKIPPED dates CHECK: existing rows violate it';
    END IF;
  END IF;
END
$fix_check_dates$;

-- ── 6. indexes (incl. the race-proof one-active-per-member+content index) ───
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_gym
  ON gym_content_assignments (gym_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_member
  ON gym_content_assignments (member_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_workout
  ON gym_content_assignments (workout_id) WHERE workout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gym_content_assignments_item
  ON gym_content_assignments (item_id) WHERE item_id IS NOT NULL;

-- one non-expired ACTIVE assignment per (member, content) — created ONLY when
-- the existing rows are clean; duplicate ACTIVE rows (possible if rows were
-- written before the index existed) must be resolved by a human, never
-- silently deleted
DO $fix_uq$
DECLARE dups bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'gym_content_assignments'
      AND indexname = 'uq_gym_content_assignments_one_active'
  ) THEN
    SELECT COUNT(*) INTO dups FROM (
      SELECT member_id, content_type,
             COALESCE(workout_id, '00000000-0000-0000-0000-000000000000'::uuid) AS w,
             COALESCE(item_id,   '00000000-0000-0000-0000-000000000000'::uuid) AS i
      FROM gym_content_assignments WHERE status = 'ACTIVE'
      GROUP BY 1, 2, 3, 4 HAVING COUNT(*) > 1
    ) d;
    IF dups = 0 THEN
      CREATE UNIQUE INDEX uq_gym_content_assignments_one_active
        ON gym_content_assignments (
          member_id, content_type,
          COALESCE(workout_id, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(item_id,   '00000000-0000-0000-0000-000000000000'::uuid)
        )
        WHERE status = 'ACTIVE';
      RAISE NOTICE 'one-active unique index created';
    ELSE
      RAISE NOTICE 'SKIPPED one-active unique index: % duplicate ACTIVE group(s) found', dups;
      RAISE NOTICE 'find them with: SELECT member_id, content_type, workout_id, item_id, COUNT(*)';
      RAISE NOTICE '  FROM gym_content_assignments WHERE status = ''ACTIVE''';
      RAISE NOTICE '  GROUP BY 1,2,3,4 HAVING COUNT(*) > 1;  — resolve, then re-run this script';
    END IF;
  END IF;
END
$fix_uq$;

-- \echo '── AFTER: columns of gym_content_assignments ──'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'gym_content_assignments'
ORDER BY ordinal_position;

-- \echo '── DONE. Expected: exactly these 16 columns ──'
-- \echo 'id, gym_id, content_type, workout_id, item_id, member_id, status, starts_on,'
-- \echo 'ends_on, notes, assigned_version, end_reason, ended_on, assigned_by, created_at, updated_at'
-- \echo 'If content_id / content_kind are gone from the list, the drift is fixed — re-run the seed.'
