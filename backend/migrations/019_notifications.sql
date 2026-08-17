-- 019: notification system
-- notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'workout_assigned',
    'diet_assigned',
    'supplement_assigned',
    'workout_completed',
    'diet_checkin',
    'supplement_checkin'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_client_id UUID REFERENCES users(id) ON DELETE SET NULL,
  deep_link_ref TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_dismissed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_dismissed_created
  ON notifications(recipient_id, is_dismissed, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read_dismissed
  ON notifications(recipient_id, is_read, is_dismissed);

-- push_tokens table (user can have multiple devices)
CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- trainer_clients: add notification preference column
ALTER TABLE trainer_clients ADD COLUMN IF NOT EXISTS trainer_notifications_enabled BOOLEAN NOT NULL DEFAULT true;