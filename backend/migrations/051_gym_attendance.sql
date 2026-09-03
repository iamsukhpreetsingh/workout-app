-- 051: Gym attendance (Phase 10).
--
-- Attendance belongs to the GymMember — app accounts are never involved
-- (a member with app_user_id = NULL checks in via QR or front desk exactly
-- like an app-connected one).
--
-- IDEMPOTENCY RULE (spec: 08:00 QR + 08:02 QR + 10:00 Workout = ONE visit):
--   a new record is created only when the member has NO record on the same
--   gym-local calendar day AND NO record within the previous 6 hours.
--   The 6-hour window additionally collapses visits that span midnight
--   (23:50 QR → 00:10 workout next day = one visit). The check is enforced
--   in-transaction with the previous record locked.
--
-- Timezone: `local_date` is the calendar day in the GYM's timezone — every
-- "today/week/month/peak-hours" answer uses it, never the server clock.
--
-- Sources: QR_CHECK_IN | FRONT_DESK | WORKOUT_COMPLETION | ADMIN_MANUAL.
-- Offline check-ins (queued on a scanner, synced later) carry client_time;
-- device-clock errors are corrected server-side (future times replaced by
-- server time and flagged).

CREATE SEQUENCE IF NOT EXISTS attendance_seq;

CREATE TABLE IF NOT EXISTS gym_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('QR_CHECK_IN', 'FRONT_DESK', 'WORKOUT_COMPLETION', 'ADMIN_MANUAL')),
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  local_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  client_time TIMESTAMPTZ,          -- as claimed by an offline device, if any
  time_corrected BOOLEAN NOT NULL DEFAULT false,
  recorded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_attendance_gym_date
  ON gym_attendance (gym_id, local_date DESC);
CREATE INDEX IF NOT EXISTS idx_gym_attendance_member
  ON gym_attendance (member_id, local_date DESC);
CREATE INDEX IF NOT EXISTS idx_gym_attendance_checkin
  ON gym_attendance (gym_id, check_in_at DESC);

-- Member QR identity: the QR encodes this token (NOT the member code —
-- codes are readable/guessable, tokens are 128-bit). Unique globally, so a
-- token from another gym resolves unambiguously and is rejected there.
ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS qr_token TEXT UNIQUE;
ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS qr_issued_at TIMESTAMPTZ;
