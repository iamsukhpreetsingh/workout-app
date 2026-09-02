-- 046: Invitation acceptance bridge (Phase 5).
--
-- The invitation is the ONLY way a person connects a GymMember to a User
-- without staff doing it manually. The plaintext code IS the bearer token
-- (128-bit random, shown once, stored SHA-256-hashed); acceptance requires
-- the accepting account's email to match the invited email exactly.
--
-- Full lifecycle: PENDING → ACCEPTED | DECLINED | EXPIRED | CANCELLED.
-- EXPIRED is enforced via expires_at (set at invite time) and evaluated
-- lazily; rows flip to EXPIRED when touched after the deadline.

ALTER TABLE gym_member_invites
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  ADD COLUMN IF NOT EXISTS accepted_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE gym_member_invites DROP CONSTRAINT IF EXISTS gym_member_invites_status_check;
ALTER TABLE gym_member_invites ADD CONSTRAINT gym_member_invites_status_check
  CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'));
