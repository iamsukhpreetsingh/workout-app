-- 045: Complete gym member management (Phase 4).
--
-- Two INDEPENDENT state axes on a GymMember (spec: never combine them):
--   MEMBERSHIP     gym_members.status         (ACTIVE/PENDING/FROZEN/EXPIRED/CANCELLED)
--   APP CONNECTION app_user_id + app_invite_status
--                  app_user_id set          → CONNECTED
--                  invite pending         → INVITATION_PENDING
--                  otherwise              → NOT_CONNECTED
-- (derived in the data layer — never stored as a single column)
--
-- Profile fields are deliberately minimal: no government IDs, no health
-- data — that belongs to the app-side intake profile, not the gym record.
--
-- `gym_member_invites` records the invitation to join the app. One PENDING
-- invite per member (partial unique index). Codes are stored HASHED — the
-- plaintext code is shown once by the portal / emailed and never persisted.

ALTER TABLE gym_members
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS gender TEXT
    CHECK (gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
  ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS app_invite_status TEXT NOT NULL DEFAULT 'none'
    CHECK (app_invite_status IN ('none', 'pending')),
  ADD COLUMN IF NOT EXISTS app_invite_sent_at TIMESTAMPTZ;

-- Spec example uses GM-prefixed member ids (GM-1001). Existing rows keep
-- their codes; only the DEFAULT changes.
ALTER TABLE gym_members
  ALTER COLUMN member_code SET DEFAULT 'GM-' || lpad(nextval('gym_member_code_seq')::text, 6, '0');

CREATE TABLE IF NOT EXISTS gym_member_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED')),
  invited_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);

-- at most one PENDING invite per member
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gym_member_invite_pending
  ON gym_member_invites(member_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_gym_member_invites_gym
  ON gym_member_invites(gym_id, status);
