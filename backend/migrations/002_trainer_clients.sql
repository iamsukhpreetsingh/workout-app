-- 002: trainer-client association + invite codes
CREATE TABLE IF NOT EXISTS trainer_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('trainer', 'client')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

-- One non-revoked association per (trainer, client) pair; re-requesting
-- after a revoke inserts a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trainer_client_active
  ON trainer_clients(trainer_id, client_id)
  WHERE status != 'revoked';

CREATE TABLE IF NOT EXISTS trainer_invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  code TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
