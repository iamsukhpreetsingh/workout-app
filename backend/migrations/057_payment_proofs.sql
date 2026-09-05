-- 057: Payment proof submission, admin verification & receipts (Phase M11).
--
-- A member-submitted payment proof is EVIDENCE, not a payment. It lives in
-- its own table with its own lifecycle (PENDING_VERIFICATION → APPROVED /
-- REJECTED / CANCELLED_BY_MEMBER / SUPERSEDED) and only an admin APPROVAL
-- creates the authoritative ledger payment (reusing recordPayment, which is
-- receipt-generating and idempotent by the FOR UPDATE lock + status check).
--
-- Statuses never leak into the payment ledger: a PENDING_VERIFICATION proof
-- leaves the charge DUE/OVERDUE; the ledger only moves on approval.
--
-- Duplicate protection (partial unique indexes):
--   • one PENDING_VERIFICATION proof per charge
--   • one PENDING_VERIFICATION proof per (gym, transaction_id) — provider
--     transaction ids are only unique WITHIN a gym, never globally.
--
-- content_id-style polymorphism is unnecessary here: a proof always targets
-- exactly one outstanding charge (membership_id rides on the charge).

CREATE TABLE IF NOT EXISTS gym_payment_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  charge_id UUID NOT NULL REFERENCES membership_charges(id) ON DELETE CASCADE,
  membership_id UUID NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('UPI', 'CARD', 'BANK_TRANSFER', 'OTHER')),
  transaction_id TEXT NOT NULL,
  paid_on DATE NOT NULL,
  screenshot_provider TEXT NOT NULL DEFAULT 'local' CHECK (screenshot_provider IN ('s3', 'local')),
  screenshot_key TEXT NOT NULL,
  screenshot_mime TEXT NOT NULL,
  screenshot_size INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (status IN ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED', 'CANCELLED_BY_MEMBER', 'SUPERSEDED')),
  rejection_reason TEXT,
  supersede_reason TEXT,
  payment_id UUID NULL,            -- set on APPROVAL (the ledger payment)
  submitted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one pending proof per charge
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_proof_pending_charge
  ON gym_payment_proofs (charge_id) WHERE status = 'PENDING_VERIFICATION';
-- one pending proof per transaction id within a gym (providers reuse ids
-- across gyms — never globally unique)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_proof_pending_txn
  ON gym_payment_proofs (gym_id, lower(transaction_id)) WHERE status = 'PENDING_VERIFICATION';
CREATE INDEX IF NOT EXISTS idx_payment_proofs_gym_status
  ON gym_payment_proofs (gym_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_member
  ON gym_payment_proofs (member_id, created_at DESC);

-- member notifications for the proof lifecycle
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'workout_assigned', 'diet_assigned', 'supplement_assigned', 'workout_completed',
  'diet_checkin', 'supplement_checkin', 'admin_broadcast', 'sync_retry_nudge',
  'gym_announcement', 'gym_payment_proof'
));
