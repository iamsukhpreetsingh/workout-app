-- 027: progression-formula configuration storage. The backend stores WHICH
-- formula + params apply to which user — calculation itself runs on-device
-- (mobile registry). This is config, not logic.
--
-- Resolution order (GET /client/progression-resolved does this in ONE place):
--   1. trainer_client_progression_overrides row with a NON-NULL formula_key
--      AND a currently-ACTIVE trainer-client association (archived trainers'
--      overrides stop applying)
--   2. the user's own user_progression_settings (created lazily on first
--      write; defaults to the app default if never touched)
--   3. the app default: 'linear_progression' with its default params
--
-- overrides.formula_key is NULLABLE on purpose: NULL = "trainer has not set
-- an override" (falls through to the client's own setting), which is a
-- DIFFERENT state from the trainer explicitly choosing the app default's
-- key (an explicit decision that must NOT fall through).

CREATE TABLE IF NOT EXISTS user_progression_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  formula_key TEXT NOT NULL DEFAULT 'linear_progression',
  params JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS trainer_client_progression_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES users(id),
  formula_key TEXT NULL,
  params JSONB NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, client_id)
);