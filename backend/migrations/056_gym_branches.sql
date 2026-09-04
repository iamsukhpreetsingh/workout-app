-- 056: Multi-branch gym management (Phase 16).
--
-- ARCHITECTURE: the Gym remains the tenant; a Branch is a subdivision.
-- Branches are never deleted — they are CLOSED (status INACTIVE). All
-- historical rows (attendance, payments, memberships, transfers) keep
-- their branch references forever; nothing cascades away history.
--
-- BRANCH (gym_branches)
--   name / address / phone / email / hours / timezone / status.
--   UNIQUE (gym_id, lower(name)) — one "Mohali" per gym.
--
-- MEMBER (gym_members)
--   primary_branch_id   the member's home branch (NULL = legacy/unassigned
--                       member: treated as "all branches" for access, so
--                       pre-branch members keep working untouched).
--   allowed_branch_ids  UUID[] — additional branches the member may use
--                       (multi-club access). Access set = {primary} ∪ allowed.
--   branch (text)       KEPT and auto-synced to the primary branch's NAME —
--                       Phase 14 SPECIFIC_BRANCH announcements and any other
--                       label-based logic keep working unchanged.
--
-- STAFF (gym_staff)
--   branch_ids UUID[] — empty = ALL branches (owner default). Non-empty =
--                       restricted (e.g. Front Desk → Mohali only). OWNER is
--                       always all-branches regardless of this column.
--
-- PLANS (membership_plans)
--   branch_ids UUID[] — empty = sold at every branch. Non-empty = only
--                       members whose PRIMARY branch is in the list can be
--                       assigned the plan (checked at assignment time).
--
-- ATTENDANCE (gym_attendance)
--   branch_id — where the visit happened. NULL = legacy row (or a branch-less
--   member visiting before branches existed). Historical rows are never
--   rewritten.
--
-- TRANSFERS (gym_branch_transfers) — the audit trail of member moves between
--   branches (append-only; the historical edge case).

CREATE TABLE IF NOT EXISTS gym_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  phone TEXT,
  email TEXT,
  operating_hours JSONB,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one branch name per gym (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_branches_gym_name
  ON gym_branches (gym_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_gym_branches_gym
  ON gym_branches (gym_id, status, created_at);

-- ── members: primary + allowed branches ──────────────────────────────────

ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS primary_branch_id
  UUID REFERENCES gym_branches(id) ON DELETE SET NULL;
ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS allowed_branch_ids
  UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_gym_members_branch
  ON gym_members (gym_id, primary_branch_id);

-- ── staff: branch restriction (empty = all branches) ─────────────────────

ALTER TABLE gym_staff ADD COLUMN IF NOT EXISTS branch_ids UUID[] NOT NULL DEFAULT '{}';

-- ── plans: branch availability (empty = all branches) ────────────────────

ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS branch_ids UUID[] NOT NULL DEFAULT '{}';

-- ── attendance: where the visit happened ─────────────────────────────────

ALTER TABLE gym_attendance ADD COLUMN IF NOT EXISTS branch_id
  UUID REFERENCES gym_branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_gym_attendance_branch
  ON gym_attendance (gym_id, branch_id, local_date DESC);

-- ── transfers: append-only member move history ───────────────────────────

CREATE TABLE IF NOT EXISTS gym_branch_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  from_branch_id UUID NULL REFERENCES gym_branches(id) ON DELETE SET NULL,
  to_branch_id UUID NULL REFERENCES gym_branches(id) ON DELETE SET NULL,
  reason TEXT,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_branch_transfers_member
  ON gym_branch_transfers (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_branch_transfers_gym
  ON gym_branch_transfers (gym_id, created_at DESC);

-- ── backfill: existing free-form `branch` labels become real branches ─────
-- Every distinct label per gym becomes an ACTIVE branch (inheriting the
-- gym's timezone), and its members become that branch's primary members.
-- The label stays synced (it IS the branch name), so Phase 14
-- SPECIFIC_BRANCH audiences keep resolving exactly as before.

INSERT INTO gym_branches (gym_id, name, timezone)
SELECT DISTINCT g.id, btrim(m.branch), g.timezone
FROM gym_members m
JOIN gyms g ON g.id = m.gym_id
WHERE m.branch IS NOT NULL AND length(btrim(m.branch)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM gym_branches b
    WHERE b.gym_id = g.id AND lower(btrim(b.name)) = lower(btrim(m.branch))
  );

UPDATE gym_members m
SET primary_branch_id = b.id
FROM gym_branches b
WHERE b.gym_id = m.gym_id
  AND lower(btrim(b.name)) = lower(btrim(m.branch))
  AND m.primary_branch_id IS NULL
  AND m.branch IS NOT NULL;
