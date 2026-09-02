-- 049: Gym staff & trainer management (Phase 8).
--
-- TRAINER DISTINCTION (spec): a trainer is NOT assumed to be a gym employee.
--  * platform trainer  = users.role 'trainer' (the coaching marketplace side)
--  * gym trainer       = gym_staff row with gym_role 'TRAINER' (gym-scoped)
--  * independent       = neither
--  * multi-gym         = several gym_staff rows, roles independent per gym
-- The two systems coexist: trainer_clients (platform coaching) is NEVER
-- mixed with gym_trainer_assignments (gym floor assignments).
--
-- gym_trainer_assignments works for members WITH or WITHOUT app accounts —
-- it references gym_members, never users.
--
-- gym_staff_invites: staff invitations for people WITHOUT an app account
-- (same one-time-code + hashed-token pattern as member invites).

CREATE TABLE IF NOT EXISTS gym_trainer_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  trainer_staff_id UUID NOT NULL REFERENCES gym_staff(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ended_on DATE,
  end_reason TEXT,
  assigned_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one ACTIVE trainer per member per gym (reassignment ends the previous one)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gym_trainer_assignment_active
  ON gym_trainer_assignments (member_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_gym_trainer_assignments_trainer
  ON gym_trainer_assignments (gym_id, trainer_staff_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_trainer_assignments_member
  ON gym_trainer_assignments (member_id, status);

CREATE TABLE IF NOT EXISTS gym_staff_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  gym_role TEXT NOT NULL CHECK (gym_role IN ('OWNER', 'ADMIN', 'TRAINER', 'FRONT_DESK')),
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  invited_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  accepted_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one PENDING staff invite per email per gym
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gym_staff_invite_pending
  ON gym_staff_invites (gym_id, lower(email)) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_gym_staff_invites_gym
  ON gym_staff_invites (gym_id, status);
