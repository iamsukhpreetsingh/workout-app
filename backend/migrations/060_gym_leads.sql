-- 060: Gym Leads / Visitors / Trial registration (public QR phase).
--
-- A LEAD is NOT a member: someone scanned the gym's public Lead QR and left
-- contact details. Leads live in their own table with their own lifecycle
-- (NEW → CONTACTED → TRIAL_… → JOINED / NOT_JOINED / NO_RESPONSE …) and are
-- only ever converted into a member through the EXISTING member-creation
-- flow — never automatically. The Lead QR secret itself lives in
-- gyms.settings (mirroring the attendance check-in code, but a SEPARATE
-- key: one QR can never serve both purposes).
--
-- The public submission endpoint is unauthenticated by design, so the table
-- assumes hostile input: length-limited columns, enum-checked type/status,
-- and a (gym_id, phone) index for duplicate suppression.

CREATE TABLE IF NOT EXISTS gym_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 80),
  phone TEXT NOT NULL CHECK (length(btrim(phone)) BETWEEN 7 AND 20),
  email TEXT CHECK (email IS NULL OR (length(btrim(email)) <= 120 AND position('@' in email) > 1)),
  enquiry_type TEXT NOT NULL DEFAULT 'ENQUIRY'
    CHECK (enquiry_type IN ('ENQUIRY','TRIAL','VISITOR','MEMBERSHIP_ENQUIRY','GENERAL_ENQUIRY')),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','CONTACTED','TRIAL_SCHEDULED','TRIAL_COMPLETED',
                      'JOINED','NOT_JOINED','NO_RESPONSE','FOLLOW_UP','CLOSED')),
  source TEXT NOT NULL DEFAULT 'GYM_QR',
  message TEXT CHECK (message IS NULL OR length(message) <= 500),
  preferred_visit_on DATE,
  matched_member_id UUID NULL REFERENCES gym_members(id) ON DELETE SET NULL,
  converted_member_id UUID NULL REFERENCES gym_members(id) ON DELETE SET NULL,
  created_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_leads_inbox
  ON gym_leads(gym_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_leads_phone
  ON gym_leads(gym_id, phone);

-- internal staff notes — NEVER shown to the public visitor
CREATE TABLE IF NOT EXISTS gym_lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES gym_leads(id) ON DELETE CASCADE,
  note TEXT NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_lead_notes ON gym_lead_notes(lead_id, created_at DESC);
