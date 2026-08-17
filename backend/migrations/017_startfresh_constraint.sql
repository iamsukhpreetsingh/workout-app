-- 017: allow coexistence of an 'archived' row and a pending/active row
-- for the same (trainer, client) pair.
--
-- The old index (status != 'revoked') allowed only ONE non-revoked row per
-- pair, so the reactivation "Start Fresh" path — which reverts the reused
-- row to 'archived' (preserving its purge countdown) and inserts a separate
-- clean 'active' row — violated the constraint with
-- "duplicate key value violates unique constraint 'uniq_trainer_client_active'".
--
-- The real invariant is: at most one OPEN (pending or active) association
-- per pair. Multiple archived rows are legitimate (one per fresh-start
-- cycle); the purge job deletes them as their countdowns expire.

DROP INDEX IF EXISTS uniq_trainer_client_active;
CREATE UNIQUE INDEX uniq_trainer_client_active
  ON trainer_clients(trainer_id, client_id)
  WHERE status IN ('pending', 'active');
