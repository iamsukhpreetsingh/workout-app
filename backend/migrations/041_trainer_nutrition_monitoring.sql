-- 041: trainer nutrition monitoring — day/week/month views data + missed-
-- target notifications (configurable per trainer-client relationship).
--
-- 1. 'nutrition_target_missed' joins the notification type allow-list.
--    Trigger is NUTRITION TARGET PERFORMANCE only (a completed day outside
--    the target tolerance) — never meal-plan deviation.
--
-- 2. trainer_nutrition_prefs — ONE preference row per trainer-client
--    relationship (spec §18). Default is OFF: the trainer opts in per
--    client, so nobody gets spammed out of the box. A new trainer-client
--    relationship starts with no row (default off) — preferences never
--    carry across relationships.
--
-- 3. diet_target_notifications — idempotency ledger (spec §16/§17): at most
--    ONE notification per (trainer, client, log_date, direction). A client
--    logging throughout the day triggers many syncs, but the evaluation
--    only ever records one row per completed day; if the client edits the
--    historical day afterwards and it's now on target, no new notification
--    is created and the existing one simply stands as history.

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'workout_assigned',
  'diet_assigned',
  'supplement_assigned',
  'workout_completed',
  'diet_checkin',
  'supplement_checkin',
  'admin_broadcast',
  'sync_retry_nudge',
  'nutrition_target_missed'
));

CREATE TABLE IF NOT EXISTS trainer_nutrition_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_miss_notifications BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, client_id)
);

CREATE TABLE IF NOT EXISTS diet_target_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('under','over')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, client_id, log_date, direction)
);
CREATE INDEX IF NOT EXISTS idx_diet_target_notifications_client
  ON diet_target_notifications(client_id, log_date);
