-- 005: invite codes are single-use — once a client successfully redeems a
-- code, mark it used so it can't be redeemed again.
ALTER TABLE trainer_invite_codes ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;
