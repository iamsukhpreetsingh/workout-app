-- 047: Membership plans & member memberships (Phase 6).
--
-- Plans belong to a Gym and are independent of app Users. Plan rows are
-- NEVER mutated in ways that would rewrite history: member_memberships
-- snapshots name/price/currency/duration AT ASSIGNMENT TIME, so a later
-- price change or archive keeps every existing membership exactly as sold.
-- No DELETE anywhere: plans are ARCHIVED, memberships are CANCELLED/EXPIRED.
--
-- Money is stored as positive integer minor units (paise for INR).
-- ends_on is computed calendar-correctly in SQL
-- (starts_on + (duration_value || ' ' || duration_unit)::interval).
--
-- member_memberships.status:
--   ACTIVE    current membership
--   UPCOMING  early renewal — starts when the ACTIVE term ends
--   CANCELLED member left / plan changed (history kept, cancel_reason set)
--   EXPIRED    superseded by a renewal whose term has begun
-- One ACTIVE (or UPCOMING) membership per member per gym, enforced by
-- partial unique indexes.

CREATE TABLE IF NOT EXISTS membership_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_value INTEGER NOT NULL DEFAULT 1
    CHECK (duration_value > 0 AND duration_value <= 36),
  duration_unit TEXT NOT NULL DEFAULT 'month'
    CHECK (duration_unit IN ('day', 'week', 'month', 'year')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency CHAR(3) NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'gym_only'
    CHECK (access_level IN ('gym_only', 'gym_classes', 'all_access')),
  included_pt_sessions INTEGER NOT NULL DEFAULT 0
    CHECK (included_pt_sessions >= 0 AND included_pt_sessions <= 500),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- duplicate plan names within one gym are rejected; other gyms unaffected
CREATE UNIQUE INDEX IF NOT EXISTS uniq_membership_plans_gym_name
  ON membership_plans (gym_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_membership_plans_gym_status
  ON membership_plans (gym_id, status);

CREATE TABLE IF NOT EXISTS member_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
  -- ── snapshots: immutable record of what was actually sold ──
  plan_name TEXT NOT NULL,
  plan_duration_value INTEGER NOT NULL,
  plan_duration_unit TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency CHAR(3) NOT NULL,
  -- ── term ──
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'UPCOMING', 'CANCELLED', 'EXPIRED')),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_member_membership_active
  ON member_memberships (member_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_member_membership_upcoming
  ON member_memberships (member_id) WHERE status = 'UPCOMING';
CREATE INDEX IF NOT EXISTS idx_member_memberships_gym
  ON member_memberships (gym_id, status);
CREATE INDEX IF NOT EXISTS idx_member_memberships_member
  ON member_memberships (member_id, starts_on DESC);
