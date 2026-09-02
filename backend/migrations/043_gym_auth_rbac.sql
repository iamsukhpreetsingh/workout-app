-- 043: Gym Management foundation — authentication, authorization & RBAC.
--
-- IDENTITY RULES (Phase 0 design, see GYM_MANAGEMENT_DESIGN.md):
--  * `users` remains the GLOBAL app identity. A user may have zero gyms.
--    User.gymId is forbidden — gym relationships are separate tables.
--  * `users.role` gains 'gym_staff' (additive CHECK widening) so gym staff
--    can be routed to the web portal at login. It NEVER replaces 'user' or
--    'trainer', and authorization for gyms is decided by `gym_staff` rows,
--    not by users.role.
--  * `gym_members` are people at a gym and do NOT need an app account
--    (app_user_id NULL). When the person later joins the app, staff link
--    the existing row to the users row by verified email — never a second
--    member record, never a duplicate user.
--  * Gym roles are gym-SCOPED (a user can be ADMIN in gym A and TRAINER in
--    gym B) — decided by `gym_staff.gym_role`, never by users.role.

-- widen the global role enum additively
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'trainer', 'gym_staff'));

-- ── tenant root ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT, postal_code TEXT,
  phone TEXT, email TEXT,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── gym roles lookup (extensible without client changes) ─────────────────
CREATE TABLE IF NOT EXISTS gym_roles (
  role TEXT PRIMARY KEY,
  rank INTEGER NOT NULL,
  description TEXT
);
INSERT INTO gym_roles (role, rank, description) VALUES
  ('OWNER',      10, 'Full control of the gym'),
  ('ADMIN',      20, 'Day-to-day administration'),
  ('TRAINER',    30, 'Coaches assigned members'),
  ('FRONT_DESK', 40, 'Desk operations: members, check-in, selling'),
  ('MEMBER',     90, 'App-linked gym member')
ON CONFLICT (role) DO NOTHING;

-- ── staff (login-capable, gym-scoped role) ────────────────────────────────
CREATE TABLE IF NOT EXISTS gym_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gym_role TEXT NOT NULL REFERENCES gym_roles(role),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','REMOVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(gym_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gym_staff_user ON gym_staff(user_id);

-- ── members (no app account required) ─────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS gym_member_code_seq;

CREATE TABLE IF NOT EXISTS gym_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_code TEXT NOT NULL DEFAULT ('M' || lpad(nextval('gym_member_code_seq')::text, 6, '0')),
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  app_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','PENDING','FROZEN','EXPIRED','CANCELLED')),
  joined_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(gym_id, member_code)
);
CREATE INDEX IF NOT EXISTS idx_gym_members_gym_status ON gym_members(gym_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_members_app_user ON gym_members(app_user_id);
-- one ACTIVE app-linked membership per user per gym (linking never duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gym_members_active_app_user
  ON gym_members(gym_id, app_user_id)
  WHERE app_user_id IS NOT NULL AND status IN ('ACTIVE','PENDING','FROZEN');

-- ── audit log (append-only; no UPDATE/DELETE anywhere in the app) ─────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NULL REFERENCES gyms(id) ON DELETE CASCADE,
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_gym ON audit_logs(gym_id, created_at DESC);
