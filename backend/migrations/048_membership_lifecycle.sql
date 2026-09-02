-- 048: Membership lifecycle management (Phase 7).
--
-- States: ACTIVE | FROZEN | UPCOMING | CANCELLED | EXPIRED.
--
-- FREEZE BUSINESS RULE (one consistent rule everywhere): freezing pauses
-- the term; when the freeze ends (resume or cancel), ends_on moves forward
-- by the EXACT number of frozen calendar days (resume date itself is not
-- frozen). A scheduled renewal (UPCOMING) shifts by the same days so the
-- next term still starts the day after the (new) term end.
--
-- membership_freezes keeps every freeze; membership_events keeps an
-- append-only lifecycle timeline (assigned/frozen/resumed/extended/
-- renewed/cancelled/expired/plan_changed) so status transitions are never
-- a bare `status = ACTIVE` overwrite.
--
-- Expiry & promotion are evaluated against the GYM's timezone and applied
-- lazily on read (idempotent UPDATEs), so no cron is required.

ALTER TABLE member_memberships DROP CONSTRAINT IF EXISTS member_memberships_status_check;
ALTER TABLE member_memberships ADD CONSTRAINT member_memberships_status_check
  CHECK (status IN ('ACTIVE', 'FROZEN', 'UPCOMING', 'CANCELLED', 'EXPIRED'));

CREATE TABLE IF NOT EXISTS membership_freezes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES member_memberships(id) ON DELETE CASCADE,
  starts_on DATE NOT NULL,
  ended_on DATE,             -- set when the freeze ends (resume/cancel)
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ENDED', 'CANCELLED')),
  reason TEXT,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one open freeze per membership
CREATE UNIQUE INDEX IF NOT EXISTS uniq_membership_freeze_active
  ON membership_freezes (membership_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_membership_freezes_membership
  ON membership_freezes (membership_id, status);

CREATE TABLE IF NOT EXISTS membership_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES member_memberships(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  details JSONB NOT NULL DEFAULT '{}',
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_events_membership
  ON membership_events (membership_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_events_gym
  ON membership_events (gym_id, created_at DESC);
