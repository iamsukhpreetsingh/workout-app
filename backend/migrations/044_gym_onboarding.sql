-- 044: Gym owner onboarding & gym setup (Phase 2).
--
-- Extends `gyms` with the profile the create-gym wizard collects:
--   website, logo (storage key), operating_hours, branding.
-- Deliberately separate JSONB columns (not stuffed into `settings`):
-- operating_hours and branding are first-class profile concepts with their
-- own validation and UI screens; `settings` stays a free-form escape hatch.
--
-- Status model:
--   ACTIVE     — normal operation
--   INACTIVE   — owner-deactivated (self-service; reversible by the owner)
--   SUSPENDED  — platform-admin suspension (NOT self-service reversible)
--
-- Everything is additive; no backfill needed (Phase 1 rows have no profile).

ALTER TABLE gyms ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS logo_key TEXT;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS logo_provider TEXT CHECK (logo_provider IN ('s3', 'local'));
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS operating_hours JSONB;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS branding JSONB;

-- widen the status enum additively with the owner-controlled INACTIVE state
ALTER TABLE gyms DROP CONSTRAINT IF EXISTS gyms_status_check;
ALTER TABLE gyms ADD CONSTRAINT gyms_status_check
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INACTIVE'));
