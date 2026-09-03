-- 050: Gym billing & payment ledger (Phase 9).
--
-- FINANCIAL INTEGRITY RULES:
--  * membership_charges  — what a member owes (auto-created from membership
--    terms with the assignment-time price snapshot; manual charges allowed).
--  * membership_payments — receipts. IMMUTABLE: no API route ever updates
--    or deletes a payment; corrections happen through additive refunds.
--    receipt_number is assigned from a sequence at insert and never changes.
--  * payment_refunds     — additive refund entries against a payment.
--  * Plan price changes NEVER touch charges/payments/receipts (charges
--    snapshot the term price at creation, like memberships do).
--  * Everything references gym_members — app_user_id NULL is fully valid.
--
-- Charge status is DERIVED from payments and refunds (DUE / PARTIAL / PAID /
-- OVERDUE / REFUNDED) so the ledger can never drift out of sync.

CREATE SEQUENCE IF NOT EXISTS payment_receipt_seq;

CREATE TABLE IF NOT EXISTS membership_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  membership_id UUID NULL REFERENCES member_memberships(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency CHAR(3) NOT NULL,
  period_start DATE,
  period_end DATE,
  due_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_charges_gym
  ON membership_charges (gym_id, due_on DESC);
CREATE INDEX IF NOT EXISTS idx_membership_charges_member
  ON membership_charges (member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  charge_id UUID NOT NULL REFERENCES membership_charges(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER')),
  paid_on DATE NOT NULL,
  receipt_number TEXT NOT NULL UNIQUE,
  note TEXT,
  recorded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_payments_gym
  ON membership_payments (gym_id, paid_on DESC);
CREATE INDEX IF NOT EXISTS idx_membership_payments_member
  ON membership_payments (member_id, paid_on DESC);
CREATE INDEX IF NOT EXISTS idx_membership_payments_charge
  ON membership_payments (charge_id);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES membership_payments(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  refunded_on DATE NOT NULL,
  refunded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment
  ON payment_refunds (payment_id);
