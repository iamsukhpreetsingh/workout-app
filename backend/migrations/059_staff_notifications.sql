-- 059: Gym staff Notification Center (gym-web phase).
--
-- A SECOND, SEPARATE notification stream from the member-facing `notifications`
-- table: business events inside a gym (payment proofs, member lifecycle,
-- membership changes, inactivity …) surfaced to AUTHORIZED STAFF in the
-- portal. Every row is targeted: gym_id + recipient_user_id are mandatory —
-- there are no broadcast rows a whole gym can read. Recipient selection,
-- permission filtering and self-action suppression live in the data layer
-- (gymStaffNotifications.js); this table only stores what was approved to
-- exist.
--
-- Not audit: the audit_logs table stays the permanent security record. A
-- notification is an operational message and may be filtered out by
-- permission even when the audit row exists.
--
-- Idempotency: dedupe_key (unique where present) lets retries and repeated
-- lazy scans never create duplicates for the same business event.
-- Retention: rows are never auto-deleted by the app; cleanup is an explicit
-- ops decision (deleting a notification NEVER touches business records).

CREATE TABLE IF NOT EXISTS gym_staff_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO','SUCCESS','WARNING','CRITICAL')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  member_id UUID NULL REFERENCES gym_members(id) ON DELETE SET NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedupe_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- the inbox access pattern: one recipient, one gym, newest first
CREATE INDEX IF NOT EXISTS idx_staff_notif_inbox
  ON gym_staff_notifications(recipient_user_id, gym_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_notif_unread
  ON gym_staff_notifications(recipient_user_id, is_read)
  WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_staff_notif_member
  ON gym_staff_notifications(member_id)
  WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_notif_entity
  ON gym_staff_notifications(gym_id, entity_type, entity_id);

-- idempotency: the same business event (retry / repeated scan) can only
-- ever create one row PER RECIPIENT per key
CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_notif_dedupe
  ON gym_staff_notifications(dedupe_key, recipient_user_id)
  WHERE dedupe_key IS NOT NULL;
