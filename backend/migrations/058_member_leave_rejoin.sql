-- 058: Member LEAVE / REJOIN lifecycle (multi-gym phase).
--
-- A gym_members row is the GYM-SCOPED relationship between a global user
-- and a gym. Leaving must never delete it: the row (and every historical
-- membership, payment, attendance, trainer, content record keyed to it)
-- survives with status LEFT so the person can rejoin into the SAME
-- identity later.
--
-- Terminology: the existing system already has CANCELLED (admin-cancelled
-- membership, no automatic rejoin semantics). We add LEFT as the
-- "former member" state used by BOTH user-initiated leave and admin
-- removal, with left_reason distinguishing the two:
--   USER_LEFT         — the app user left voluntarily (JWT-derived)
--   REMOVED_BY_ADMIN  — gym staff archived the member
-- left_at records when the relationship ended (cleared on rejoin; the
-- audit log keeps the full leave/rejoin timeline permanently).
--
-- NOT changed: users, member_memberships, membership_charges/payments,
-- attendance, documents — financial and attendance history is NEVER
-- rewritten by a relationship action.

ALTER TABLE gym_members DROP CONSTRAINT IF EXISTS gym_members_status_check;
ALTER TABLE gym_members ADD CONSTRAINT gym_members_status_check
  CHECK (status IN ('ACTIVE','PENDING','FROZEN','EXPIRED','CANCELLED','LEFT'));

ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ;
ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS left_reason TEXT
  CHECK (left_reason IN ('USER_LEFT','REMOVED_BY_ADMIN'));

-- One relationship per user per gym across the "remembered" states
-- (ACTIVE/PENDING/FROZEN/LEFT). A rejoin REACTIVATES the LEFT row instead
-- of inserting a duplicate; CANCELLED stays outside so legacy data (a
-- cancelled row + a fresh membership) keeps working.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gym_members_relationship
  ON gym_members(gym_id, app_user_id)
  WHERE app_user_id IS NOT NULL AND status IN ('ACTIVE','PENDING','FROZEN','LEFT');
