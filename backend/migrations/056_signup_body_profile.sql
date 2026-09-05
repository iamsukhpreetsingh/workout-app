-- 056: signup body profile (Mobile M10).
--
-- Signup (user role) now collects date of birth / gender / weight / height
-- and seeds the client's INTAKE PROFILE (client_intake_profiles) — the
-- canonical home these fields already live in. The health-profile form then
-- pre-populates from here; nothing is asked twice.
--
-- completed_at stays NULL: a seeded signup profile is NOT a completed health
-- profile — allergen warnings and the trainer-side completion gate stay off
-- until the member actually finishes the intake form.

ALTER TABLE client_intake_profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
