-- 023: client intake profiles — health context a client fills in once
-- (onboarding) and can edit later from settings.
--
-- ONE profile per client (PK = client_user_id), shared across ALL of the
-- client's trainers: the profile belongs to the CLIENT, not the pair.
--
--   allergens            → drives trainer-side conflict warnings (the ONLY
--                          auto-matched field, by explicit design decision)
--   goals / injuries /   → display-only context ("Client Context" section
--     medical_conditions   in the diet plan builder); never auto-matched
--
-- completed_at gates ALL allergen checking: NULL (or no row) means the
-- app skips warnings entirely — no error, no block.
--
-- SENSITIVE: never include these fields in notification bodies or logs
-- beyond normal error tracebacks.
CREATE TABLE IF NOT EXISTS client_intake_profiles (
  client_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  allergens TEXT[] NOT NULL DEFAULT '{}',
  goals TEXT[] NOT NULL DEFAULT '{}',
  injuries TEXT,
  medical_conditions TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);