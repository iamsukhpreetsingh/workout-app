-- 026: custom exercises gain optional equipment + body_part (enriched
-- exercise-library feature). The multilingual seed data itself is
-- DEVICE-LOCAL by design — every device bundles the same JSON — so only
-- custom exercises carry new fields through backup/sync.
ALTER TABLE backup_custom_exercises ADD COLUMN IF NOT EXISTS equipment TEXT;
ALTER TABLE backup_custom_exercises ADD COLUMN IF NOT EXISTS body_part TEXT;