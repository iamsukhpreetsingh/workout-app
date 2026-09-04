-- ─────────────────────────────────────────────────────────────────────────
-- FIX: stale "content_kind" column in gym_content_assignments
--
-- Your database's gym_content_assignments table was created by an EARLY
-- draft of migration 054 (which used a column named content_kind). The
-- final Phase 13 code renamed it to content_type. The drift-tolerant 054
-- later ADDED content_type (ADD COLUMN IF NOT EXISTS) but could not remove
-- the stale content_kind column — which is still NOT NULL with no default.
--
-- Every assignment INSERT from current code sets content_type and knows
-- nothing of content_kind → NOT NULL violation → 400 on every create
-- → the 28 test failures.
-- ─────────────────────────────────────────────────────────────────────────

-- ── STEP 1: LOOK before you leap (optional but recommended) ────────────
-- Run this and compare with the canonical list below:
-- SELECT column_name, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'gym_content_assignments'
-- ORDER BY ordinal_position;

-- Canonical columns (exactly these, nothing more):
--   id, gym_id, content_type, workout_id, item_id, member_id, status,
--   starts_on, ends_on, notes, assigned_version, end_reason, ended_on,
--   assigned_by, created_at, updated_at
--
-- ANY column not in that list (e.g. content_kind) is stale → drop it.

-- ── STEP 2: the surgical fix (keeps existing rows) ─────────────────────
ALTER TABLE gym_content_assignments DROP COLUMN IF EXISTS content_kind;

-- If STEP 1 revealed OTHER stale columns (anything not in the canonical
-- list), drop those too, e.g.:
-- ALTER TABLE gym_content_assignments DROP COLUMN IF EXISTS <stale_col>;

-- ── STEP 3: verify ──────────────────────────────────────────────────────
-- cd backend && npm test
-- Expected: 293 tests, 292 pass (1 pre-existing exerciseCatalog env failure)

-- ── ALTERNATIVE: clean rebuild (if the table's data is disposable) ─────
-- The table was half-broken anyway; this recreates it canonically and
-- re-runs the 054 backfill from the old Phase 11/12 domain tables if they
-- still exist in their original shape:
--
--   DROP TABLE gym_content_assignments CASCADE;
--   DELETE FROM schema_migrations WHERE filename = '054_gym_content_assignments.sql';
--   -- then: cd backend && npm run migrate && npm test
--
-- Note: DROP + re-migrate loses whatever rows sit in the broken table
-- (they could not have been created by the current app anyway).
