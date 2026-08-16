-- 015: trainer-client unlink with archive-then-purge lifecycle.
-- 'archived' = either party unlinked; trainer keeps READ-ONLY access for
-- 30 days (purge_at stored explicitly). 'revoked' = terminal, post-purge.
ALTER TABLE trainer_clients DROP CONSTRAINT IF EXISTS trainer_clients_status_check;
ALTER TABLE trainer_clients
  ADD CONSTRAINT trainer_clients_status_check
  CHECK (status IN ('pending', 'active', 'archived', 'revoked'));

ALTER TABLE trainer_clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;
ALTER TABLE trainer_clients ADD COLUMN IF NOT EXISTS archived_by TEXT NULL
  CHECK (archived_by IN ('trainer', 'client'));
ALTER TABLE trainer_clients ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ NULL;
