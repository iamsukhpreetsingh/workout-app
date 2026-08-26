-- Admin Management section (testing area):
--   1) Global progression-formula parameter overrides — one authoritative
--      row per formula key; merged UNDER schema defaults so any user without
--      an explicit trainer/user-specific override gets the admin-set values.
--      Historical calculations are never rewritten.
--   2) Soft-archive support for the global exercise library — hard deletes
--      are never performed; historical references stay intact.
CREATE TABLE IF NOT EXISTS progression_formula_globals (
  formula_key TEXT PRIMARY KEY,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE exercises ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS exercises_archived_idx ON exercises (is_archived);
