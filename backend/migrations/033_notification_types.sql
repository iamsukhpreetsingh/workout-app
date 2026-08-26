-- Widen the notifications type allow-list for admin-originated
-- notifications (ADMIN.md Phase 10/11): platform broadcasts and the
-- sync-retry nudge sent by the admin dashboard. Additive only.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'workout_assigned',
  'diet_assigned',
  'supplement_assigned',
  'workout_completed',
  'diet_checkin',
  'supplement_checkin',
  'admin_broadcast',
  'sync_retry_nudge'
));
