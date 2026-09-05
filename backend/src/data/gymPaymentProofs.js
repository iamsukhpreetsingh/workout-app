const fs = require('fs');
// gymPaymentProofs.js — member-submitted payment proofs (Phase M11).
//
// LIFECYCLE: PENDING_VERIFICATION → APPROVED | REJECTED |
// CANCELLED_BY_MEMBER | SUPERSEDED. A proof is EVIDENCE, not a payment:
// the underlying charge stays DUE/OVERDUE until an admin APPROVES, and
// approval creates the authoritative ledger payment via the existing
// recordPayment (receipt-generating, race-safe) — never a second payment
// system.
//
// MEMBER SAFETY: the proof is resolved to the caller's own member row and
// their own outstanding charge — chargeId from the client is validated by
// ownership, never trusted. Amount must be > 0 and ≤ outstanding (partial
// allowed per existing rules; overpayment rejected). One PENDING proof per
// charge and one per (gym, transaction id) — database-enforced.
//
// SCREENSHOTS: base64 through the authorized backend route (the app never
// touches storage credentials), magic-byte validated, ≤5MB, generated
// object names, S3 in production / local dev fallback with a loud
// production failure.
const { query, transaction } = require('../db/pool');
const billing = require('./gymBilling');
const proofStorage = require('./paymentProofStorage');
const { createNotification } = require('./notifications');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const METHODS = ['UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE = {
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

const PROOF_SELECT = `
  SELECT pr.*,
         gm.member_code, gm.first_name, gm.last_name, gm.app_user_id,
         c.description AS charge_description, c.amount_cents AS charge_amount_cents,
         c.due_on AS charge_due_on,
         c.period_start, c.period_end, mm.plan_name,
         su.name AS submitted_by_name, ru.name AS reviewed_by_name
  FROM gym_payment_proofs pr
  JOIN gym_members gm ON gm.id = pr.member_id
  JOIN membership_charges c ON c.id = pr.charge_id
  LEFT JOIN member_memberships mm ON mm.id = c.membership_id
  LEFT JOIN users su ON su.id = pr.submitted_by
  LEFT JOIN users ru ON ru.id = pr.reviewed_by`;

function proofToClient(row) {
  return {
    ...row,
    status_label: row.status === 'PENDING_VERIFICATION' ? 'PENDING VERIFICATION' : row.status,
  };
}

async function getProof(gymId, proofId) {
  const { rows } = await query(
    `${PROOF_SELECT} WHERE pr.gym_id = $1 AND pr.id = $2`, [gymId, proofId]
  );
  return rows[0] ? proofToClient(rows[0]) : null;
}

// resolve the caller's member row for a gym via the JWT
async function resolveMemberRow(client, gymId, userId) {
  const { rows } = await client.query(
    `SELECT id, status FROM gym_members
     WHERE gym_id = $1 AND app_user_id = $2 AND status IN ('ACTIVE','PENDING','FROZEN')
     ORDER BY (status = 'ACTIVE') DESC LIMIT 1`,
    [gymId, userId]
  );
  return rows[0] || null;
}

// notify the member (fire-and-forget push like every other notification;
// the notification row is the authoritative inbox record)
function notifyMember(userId, title, body, actorId = null) {
  createNotification({
    recipientId: userId, actorId, type: 'gym_payment_proof', title, body,
  }).catch((e) => console.error(`[PaymentProof] notify failed: ${e.message}`));
}

// ── member: submit ───────────────────────────────────────────────────────

async function submitProof(userId, ip, data, gymAudit) {
  const { charge_id, amount_cents, method, transaction_id, paid_on,
          screenshot_base64, content_type, notes } = data || {};

  if (!charge_id) throw new HttpError(400, 'charge_id is required');
  const amount = Number(amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, 'amount_cents must be a positive integer amount');
  }
  if (!METHODS.includes(method)) {
    throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
  }
  const txn = String(transaction_id || '').trim();
  if (txn.length < 4 || txn.length > 64) {
    throw new HttpError(400, 'transaction_id must be 4-64 characters');
  }
  if (!paid_on || !DATE_RE.test(String(paid_on))) {
    throw new HttpError(400, 'paid_on must be a YYYY-MM-DD date');
  }
  if (!screenshot_base64 || !content_type || !ALLOWED_IMAGE[content_type]) {
    throw new HttpError(400, 'A payment screenshot (PNG/JPEG/WEBP) is required');
  }

  // screenshot: untrusted upload — size + magic-byte validation, generated name
  const buffer = Buffer.from(String(screenshot_base64), 'base64');
  if (!buffer.length) throw new HttpError(400, 'screenshot_base64 is not valid base64');
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new HttpError(400, 'Screenshot exceeds the 5MB limit');
  }
  if (!ALLOWED_IMAGE[content_type].magic(buffer)) {
    throw new HttpError(400, 'screenshot_base64 does not contain a valid PNG, JPEG or WEBP image');
  }

  return transaction(async (client) => {
    // the charge MUST be one of the caller's own outstanding charges —
    // ownership is derived from the JWT, never from the payload
    const { rows: memberRows } = await client.query(
      `SELECT gm.id AS member_id, gm.status AS member_status, g.timezone AS gym_tz
       FROM membership_charges c
       JOIN gym_members gm ON gm.id = c.member_id
       JOIN gyms g ON g.id = c.gym_id
       WHERE c.id = $1 AND gm.app_user_id = $2
         AND c.gym_id = g.id AND g.status = 'ACTIVE'
       FOR UPDATE OF c`,
      [charge_id, userId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Charge not found');
    const { member_id, member_status, gym_tz } = memberRows[0];
    const gymId = (await client.query('SELECT gym_id FROM membership_charges WHERE id = $1', [charge_id])).rows[0].gym_id;

    if (member_status === 'CANCELLED') {
      throw new HttpError(403, 'This member has left the gym — payment proofs cannot be submitted');
    }

    const { rows: chargeRows } = await client.query(
      `SELECT c.amount_cents, c.currency,
              COALESCE((SELECT SUM(p.amount_cents)::int FROM membership_payments p WHERE p.charge_id = c.id), 0)
                - COALESCE((SELECT SUM(f.amount_cents)::int FROM payment_refunds f
                            JOIN membership_payments pay ON pay.id = f.payment_id
                            WHERE pay.charge_id = c.id), 0) AS net_paid,
              (now() AT TIME ZONE g.timezone)::date AS today
       FROM membership_charges c JOIN gyms g ON g.id = c.gym_id
       WHERE c.id = $1 FOR UPDATE`,
      [charge_id]
    );
    const charge = chargeRows[0];
    const outstanding = charge.amount_cents - charge.net_paid;
    if (outstanding <= 0) {
      throw new HttpError(409, 'This charge is already settled — nothing to submit a proof against');
    }
    // partial allowed (existing rules); overpayment rejected
    if (amount > outstanding) {
      throw new HttpError(400,
        `Proof amount exceeds the outstanding balance (${(outstanding / 100).toFixed(2)} ${charge.currency})`);
    }
    if (String(paid_on) > String(charge.today)) {
      throw new HttpError(400, 'The payment date cannot be in the future');
    }

    // one pending proof per charge AND per transaction id (DB-enforced too)
    const { rows: dupes } = await client.query(
      `SELECT
         (SELECT id FROM gym_payment_proofs WHERE charge_id = $1 AND status = 'PENDING_VERIFICATION') AS pending_charge,
         (SELECT id FROM gym_payment_proofs WHERE gym_id = $2 AND lower(transaction_id) = lower($3)
            AND status = 'PENDING_VERIFICATION') AS pending_txn`,
      [charge_id, gymId, txn]
    );
    if (dupes[0].pending_charge) {
      throw new HttpError(409, 'A payment proof for this charge is already pending verification');
    }
    if (dupes[0].pending_txn) {
      throw new HttpError(409, 'This transaction ID is already pending verification at this gym');
    }

    const stored = await proofStorage.upload(buffer, {
      gymId, memberId: member_id, ext: ALLOWED_IMAGE[content_type].ext,
    });

    const { rows } = await client.query(
      `INSERT INTO gym_payment_proofs
         (gym_id, member_id, charge_id, membership_id, amount_cents, currency, method,
          transaction_id, paid_on, screenshot_provider, screenshot_key, screenshot_mime,
          screenshot_size, notes, submitted_by)
       SELECT c.gym_id, c.member_id, c.id, c.membership_id, $2, c.currency, $3, $4, $5::date,
              $6, $7, $8, $9, $10, $11
       FROM membership_charges c WHERE c.id = $1
       RETURNING *`,
      [charge_id, amount, method, txn, paid_on,
       stored.provider, stored.key, content_type, buffer.length,
       notes ? String(notes).slice(0, 500) : null, userId]
    );
    const proof = rows[0];
    await gymAudit(client, {
      gymId, actorUserId: userId, ip: undefined,
      action: 'payment_proof.submitted', entity: 'gym_payment_proof', entityId: proof.id,
      after: { charge_id, amount_cents: amount, method, transaction_id: txn },
    });
    notifyMember(
      userId,
      'Payment proof submitted',
      `Your payment proof of ${(amount / 100).toFixed(2)} ${proof.currency} is pending verification.`,
      userId
    );
    return proofToClient(proof);
  });
}

// ── member: cancel own pending proof ─────────────────────────────────────

async function cancelMyProof(userId, proofId, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pr.*, gm.app_user_id FROM gym_payment_proofs pr
       JOIN gym_members gm ON gm.id = pr.member_id
       WHERE pr.id = $1 AND gm.app_user_id = $2 FOR UPDATE`,
      [proofId, userId]
    );
    if (!rows.length) throw new HttpError(404, 'Payment proof not found');
    const proof = rows[0];
    if (proof.status !== 'PENDING_VERIFICATION') {
      throw new HttpError(409, 'This payment request has already been processed');
    }
    await client.query(
      `UPDATE gym_payment_proofs SET status = 'CANCELLED_BY_MEMBER', cancelled_at = now(),
         cancelled_by = $2, updated_at = now() WHERE id = $1`,
      [proof.id, userId]
    );
    // evidence is no longer needed once the request is cancelled
    await proofStorage.remove(proof);
    await gymAudit(client, {
      gymId: proof.gym_id, actorUserId: userId, ip,
      action: 'payment_proof.cancelled', entity: 'gym_payment_proof', entityId: proof.id,
      before: { status: 'PENDING_VERIFICATION' }, after: { status: 'CANCELLED_BY_MEMBER' },
    });
    notifyMember(userId, 'Payment request cancelled',
      'Your payment verification request was cancelled.');
    return { ok: true };
  });
}

// ── admin: approve (race-safe, atomic, receipt-generating) ───────────────

async function approveProof(gymId, proofId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pr.*, gm.app_user_id AS member_user_id
       FROM gym_payment_proofs pr
       JOIN gym_members gm ON gm.id = pr.member_id
       WHERE pr.id = $1 AND pr.gym_id = $2 FOR UPDATE`,
      [proofId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Payment proof not found');
    const proof = rows[0];
    if (proof.status !== 'PENDING_VERIFICATION') {
      throw new HttpError(409, 'This payment request has already been processed');
    }

    // the charge must still be outstanding (desk may have settled it meanwhile)
    const { rows: chargeRows } = await client.query(
      `SELECT c.id, c.amount_cents,
              COALESCE((SELECT SUM(p.amount_cents)::int FROM membership_payments p WHERE p.charge_id = c.id), 0)
                - COALESCE((SELECT SUM(f.amount_cents)::int FROM payment_refunds f
                            JOIN membership_payments pay ON pay.id = f.payment_id
                            WHERE pay.charge_id = c.id), 0) AS net_paid
       FROM membership_charges c WHERE c.id = $1 FOR UPDATE`,
      [proof.charge_id]
    );
    const outstanding = chargeRows[0].amount_cents - chargeRows[0].net_paid;
    require('fs').appendFileSync('/tmp/dbg-approve.log',
      `approve: amount=${chargeRows[0].amount_cents} net=${chargeRows[0].net_paid} outstanding=${outstanding} proofAmount=${proof.amount_cents} chargeId=${proof.charge_id}\n`);
    if (outstanding <= 0) {
      await client.query(
        `UPDATE gym_payment_proofs SET status = 'SUPERSEDED',
           supersede_reason = 'Outstanding charge was already settled.', updated_at = now()
         WHERE id = $1`,
        [proof.id]
      );
      await gymAudit(client, {
        gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
        action: 'payment_proof.superseded', entity: 'gym_payment_proof', entityId: proof.id,
        after: { reason: 'charge_already_settled' },
      });
      return {
        superseded: true,
        error: 'This payment request has already been processed — the charge was settled separately',
      };
    }
    if (proof.amount_cents > outstanding) {
      // the balance shrank below the proof amount after submission (partial
      // desk payment) — requires admin review, not silent approval
      throw new HttpError(409,
        `The outstanding balance (${(outstanding / 100).toFixed(2)}) is now less than the proof amount — review and re-submit`);
    }

    // the authoritative ledger payment — existing recordPayment: receipt-
    // generating, balance/duplicate guards, one receipt per payment
    const payment = await billing.recordPayment(
      gymId, proof.member_id, actor, ip,
      { charge_id: proof.charge_id, amount_cents: proof.amount_cents,
        method: proof.method, paid_on: proof.paid_on,
        note: `Member-submitted proof (txn ${proof.transaction_id})`,
        allow_duplicate: false },
      gymAudit, client
    );

    await client.query(
      `UPDATE gym_payment_proofs SET status = 'APPROVED', payment_id = $2,
         reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`,
      [proof.id, payment.id, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'payment_proof.approved', entity: 'gym_payment_proof', entityId: proof.id,
      after: { payment_id: payment.id, receipt_number: payment.receipt_number,
               amount_cents: proof.amount_cents },
    });
    if (proof.member_user_id) {
      notifyMember(proof.member_user_id, 'Payment verified',
        `Your payment of ${(proof.amount_cents / 100).toFixed(2)} ${proof.currency} has been verified.`,
        actor?.userId ?? null);
    }
    return { proof: proofToClient({ ...proof, status: 'APPROVED' }), payment };
  });
}

// ── admin: reject ────────────────────────────────────────────────────────

async function rejectProof(gymId, proofId, actor, ip, { reason } = {}, gymAudit) {
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 4) throw new HttpError(400, 'A rejection reason (min 4 characters) is required');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pr.*, gm.app_user_id AS member_user_id
       FROM gym_payment_proofs pr
       JOIN gym_members gm ON gm.id = pr.member_id
       WHERE pr.id = $1 AND pr.gym_id = $2 FOR UPDATE`,
      [proofId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Payment proof not found');
    const proof = rows[0];
    if (proof.status !== 'PENDING_VERIFICATION') {
      throw new HttpError(409, 'This payment request has already been processed');
    }
    await client.query(
      `UPDATE gym_payment_proofs SET status = 'REJECTED', rejection_reason = $2,
         reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`,
      [proof.id, trimmed, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'payment_proof.rejected', entity: 'gym_payment_proof', entityId: proof.id,
      before: { status: 'PENDING_VERIFICATION' }, after: { status: 'REJECTED', reason: trimmed },
    });
    if (proof.member_user_id) {
      notifyMember(proof.member_user_id, 'Payment proof rejected',
        `Your payment proof of ${(proof.amount_cents / 100).toFixed(2)} ${proof.currency} was rejected: ${trimmed}`,
        actor?.userId ?? null);
    }
    return proofToClient({ ...proof, status: 'REJECTED', rejection_reason: trimmed });
  });
}

// ── reads ────────────────────────────────────────────────────────────────

async function listMyProofs(userId, gymId) {
  const { rows } = await query(
    `${PROOF_SELECT} WHERE gm.app_user_id = $1 ${gymId ? 'AND pr.gym_id = $2' : ''}
     ORDER BY pr.created_at DESC LIMIT 100`,
    gymId ? [userId, gymId] : [userId]
  );
  return rows.map(proofToClient);
}

async function listGymProofs(gymId, { status, limit = 100, offset = 0 } = {}) {
  const vals = [gymId];
  const where = ['pr.gym_id = $1'];
  if (status) { vals.push(status); where.push(`pr.status = $${vals.length}`); }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 100, 300)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `${PROOF_SELECT} WHERE ${where.join(' AND ')} ORDER BY pr.created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows.map(proofToClient);
}

// pending-verification totals for the Payments dashboard card
async function getPendingTotals(gymId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount_cents)::int, 0) AS total, COUNT(*)::int AS count
     FROM gym_payment_proofs WHERE gym_id = $1 AND status = 'PENDING_VERIFICATION'`,
    [gymId]
  );
  return rows[0];
}

module.exports = {
  submitProof, cancelMyProof, approveProof, rejectProof,
  listMyProofs, listGymProofs, getProof, getPendingTotals,
  getProofStream: async (gymId, proofId) => {
    const { rows } = await query(
      'SELECT screenshot_provider, screenshot_key, screenshot_mime FROM gym_payment_proofs WHERE id = $1 AND gym_id = $2',
      [proofId, gymId]
    );
    if (!rows.length) return { notFound: true };
    const out = await proofStorage.getStream(rows[0]);
    return out ? { stream: out.stream, mime: rows[0].screenshot_mime } : { gone: true };
  },
};
