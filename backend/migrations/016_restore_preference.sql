-- 016: reactivation preference on the relationship (Phase 4 support)
ALTER TABLE trainer_clients ADD COLUMN IF NOT EXISTS restore_preference TEXT NULL
  CHECK (restore_preference IN ('restore', 'fresh'));
