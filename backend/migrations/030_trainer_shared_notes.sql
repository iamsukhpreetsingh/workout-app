-- 030: trainer-shared exercise notes ("Share with Trainer").
--
-- DELIBERATE, DOCUMENTED EXCEPTION to the redacted trainer sync: exercise
-- notes were intentionally stripped from session_exercise_details (see the
-- migration-007-era design: "RPE and notes never included"). This migration
-- adds exactly ONE client-authored field that DOES travel to the trainer:
--
--   shared_note        — the user's "Share with Trainer" text for an
--                        exercise in a logged session (how the set felt,
--                        discomfort, questions). Written by the client's
--                        detail payload as `shared_note`; personal notes
--                        and RPE remain stripped and must NEVER be mapped
--                        here.
--
-- backup_session_exercises.trainer_note keeps the full-fidelity personal
-- backup lossless (same field under its device-side name).

ALTER TABLE session_exercise_details ADD COLUMN IF NOT EXISTS shared_note TEXT NULL;
ALTER TABLE backup_session_exercises ADD COLUMN IF NOT EXISTS trainer_note TEXT NULL;
