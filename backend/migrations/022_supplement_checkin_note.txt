-- Add note column to supplement_checkins table
ALTER TABLE supplement_checkins ADD COLUMN IF NOT EXISTS note TEXT;