-- 036: Progress Photos as a first-class feature (privacy + storage + trainer
-- sharing). REPLACES the backup-only progress_photos path: existing
-- backup_progress_photos rows are imported here as PERSONAL (decision D3 —
-- nothing becomes trainer-visible without explicit user action), and the
-- sync engine will be re-pointed at these endpoints in Phase 2.
--
-- DESIGN RULES (from the spec, enforced here and in the data layer):
--  * ONE primary photo per (user_id, photo_date) — UNIQUE constraint.
--  * visibility: 'PERSONAL' | 'TRAINER_SHARED'. Personal photos are NEVER
--    returned by any trainer endpoint — filtered server-side, not in the UI.
--  * storage_provider: 's3' | 'local' + storage_key (relative key only —
--    no absolute paths in the DB). Enables later local→S3 migration.
--  * photo_date is the USER'S local calendar date (client sends it);
--    future-date rejection runs in the data layer against APP_TIMEZONE.
--  * +1 RULE (disconnect reset): when a trainer-client association is
--    unlinked, ALL of that client's TRAINER_SHARED photos flip to PERSONAL
--    (a new trainer starts with a clean slate). Enforced in both unlink
--    routes + the purge script; the trainer read endpoint ALSO re-checks
--    association+visibility at query time (defense in depth).

CREATE TABLE IF NOT EXISTS progress_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_date DATE NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PERSONAL'
    CHECK (visibility IN ('PERSONAL', 'TRAINER_SHARED')),
  storage_provider TEXT NOT NULL DEFAULT 'local'
    CHECK (storage_provider IN ('s3', 'local')),
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, photo_date)
);
CREATE INDEX IF NOT EXISTS idx_progress_photos_user_date
  ON progress_photos(user_id, photo_date DESC);

-- Import any photos from the old backup-only system as PERSONAL. Local
-- entity ids in the old system were numeric strings; the new table's id is
-- a UUID, so the client will re-adopt rows via photo_date (one per date is
-- guaranteed by the UNIQUE constraint — ON CONFLICT keeps the first).
INSERT INTO progress_photos (user_id, photo_date, visibility, storage_provider, storage_key)
SELECT b.user_id, b.date::date, 'PERSONAL', 'local',
       'progress-photos/' || b.user_id || '/' || b.local_entity_id || '.jpg'
FROM backup_progress_photos b
ON CONFLICT (user_id, photo_date) DO NOTHING;

-- Timezone for server-side "today" (future-date validation). The user's
-- calendar date always comes from the client; this only guards against
-- accepting a date the user's timezone hasn't reached yet. Defaults to the
-- deployment region (Asia/Kolkata); overridable via APP_TIMEZONE env.