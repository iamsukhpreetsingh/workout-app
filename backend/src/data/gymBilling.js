// gymBilling.js — charges, payments (receipts) and refunds (Phase 9).
//
// RULES:
//  - Payments belong to the GymMember/Membership context; app accounts are
//    never involved (app_user_id NULL is fully valid).
//  - membership_payments and payment_refunds are IMMUTABLE financial
//    records: this module only INSERTs them. Corrections are additive
//    refunds. receipt_number comes from a sequence and never changes.
//  - Plan price changes cannot affect history: charges snapshot the term
//    price at creation (auto-charges from memberships use the membership's
//    own snapshot columns).
//  - Charge status is derived: net = payments - refunds on those payments;
//    net >= amount → PAID, 0 < net < amount → PARTIAL, net <= 0 → DUE or
//    OVERDUE (due_on passed, gym timezone), refunded fully → REFUNDED.
//  - Duplicate guard: identical (charge, amount, method, paid_on) is
//    rejected unless explicitly forced.
//  - A payment can never exceed the charge's outstanding balance.
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── charges ──────────────────────────────────────────────────────────────

// Auto-charge from a membership term — called inside the SAME transaction
// as assignment/renewal so the dues ledger can never miss a sale. Uses the
// membership's OWN snapshot columns (price/name/period), immune to later
// plan edits.
async function createChargeForMembership(client, gymId, memberId, membership, actor) {
  const { rows } = await client.query(
    `INSERT INTO membership_charges
       (gym_id, member_id, membership_id, description, amount_cents, currency,
        period_start, period_end, due_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date,
             $9)
     RETURNING *`,
    [gymId, memberId, membership.id,
     `Membership: ${membership.plan_name} (${membership.starts_on} → ${membership.ends_on})`,
     membership.price_cents, membership.currency,
     membership.starts_on, membership.ends_on, actor?.userId ?? actor ?? null]
  );
  return rows[0];
}

// Manual charge (misc dues: merch, personal training top-up, penalty…)
async function createManualCharge(gymId, memberId, actor, ip, data, gymAudit) {
  const amount = Number(data.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, 'amount_cents must be a positive integer amount');
  }
  if (!data.description || !String(data.description).trim()) {
    throw new HttpError(400, 'description is required');
  }
  if (data.due_on && !DATE_RE.test(String(data.due_on))) {
    throw new HttpError(400, 'due_on must be a YYYY-MM-DD date');
  }
  if (!/^[A-Z]{3}$/.test(String(data.currency || 'INR'))) {
    throw new HttpError(400, 'currency must be a 3-letter code');
  }
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT id FROM gym_members WHERE id = $1 AND gym_id = $2',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const { rows } = await client.query(
      `INSERT INTO membership_charges
         (gym_id, member_id, membership_id, description, amount_cents, currency,
          period_start, period_end, due_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date,
                 (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date),$10)
       RETURNING *`,
      [gymId, memberId, data.membership_id ?? null, String(data.description).trim(),
       amount, data.currency || 'INR', data.period_start ?? null, data.period_end ?? null,
       data.due_on ?? null, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'charge.created', entity: 'membership_charge', entityId: rows[0].id,
      after: { description: rows[0].description, amount_cents: rows[0].amount_cents },
    });
    return rows[0];
  });
}

// status is DERIVED here — the ledger can never disagree with itself.
const CHARGE_SELECT = `
  SELECT c.*,
    COALESCE(p.paid_total, 0) AS paid_total,
    COALESCE(r.refund_total, 0) AS refund_total,
    COALESCE(p.paid_total, 0) - COALESCE(r.refund_total, 0) AS net_paid,
    (SELECT (now() AT TIME ZONE g.timezone)::date FROM gyms g WHERE g.id = c.gym_id) AS today,
    gm.first_name, gm.last_name, gm.member_code, gm.app_user_id
  FROM membership_charges c
  JOIN gyms g ON g.id = c.gym_id
  JOIN gym_members gm ON gm.id = c.member_id
  LEFT JOIN (
    SELECT charge_id, SUM(amount_cents)::int AS paid_total
    FROM membership_payments GROUP BY charge_id
  ) p ON p.charge_id = c.id
  LEFT JOIN (
    SELECT pay.charge_id, SUM(f.amount_cents)::int AS refund_total
    FROM payment_refunds f JOIN membership_payments pay ON pay.id = f.payment_id
    GROUP BY pay.charge_id
  ) r ON r.charge_id = c.id`;

function chargeStatus(row) {
  const net = row.net_paid;
  const outstanding = Math.max(0, row.amount_cents - net);
  let status;
  if (net < 0 || (row.refund_total >= row.paid_total && row.paid_total > 0)) status = 'REFUNDED';
  else if (net >= row.amount_cents) status = 'PAID';
  else if (net > 0) status = 'PARTIAL';
  else status = row.due_on < row.today ? 'OVERDUE' : 'DUE';
  return { ...row, status, outstanding_cents: outstanding };
}

async function listMemberCharges(gymId, memberId) {
  const { rows } = await query(`${CHARGE_SELECT} WHERE c.gym_id = $1 AND c.member_id = $2 ORDER BY c.created_at DESC`, [gymId, memberId]);
  return rows.map(chargeStatus);
}

async function getCharge(gymId, chargeId) {
  const { rows } = await query(`${CHARGE_SELECT} WHERE c.gym_id = $1 AND c.id = $2`, [gymId, chargeId]);
  return rows[0] ? chargeStatus(rows[0]) : null;
}

// ── payments (receipts) ──────────────────────────────────────────────────

async function recordPayment(gymId, memberId, actor, ip, data, gymAudit) {
  const amount = Number(data.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, 'amount_cents must be a positive integer amount');
  }
  if (!METHODS.includes(data.method)) {
    throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
  }
  if (!data.paid_on || !DATE_RE.test(String(data.paid_on))) {
    throw new HttpError(400, 'paid_on must be a YYYY-MM-DD date');
  }
  return transaction(async (client) => {
    // the charge MUST belong to this member of THIS gym — "wrong member /
    // wrong membership" is structurally impossible
    const { rows: chargeRows } = await client.query(
      `SELECT c.*, (now() AT TIME ZONE g.timezone)::date AS today
       FROM membership_charges c JOIN gyms g ON g.id = c.gym_id
       WHERE c.id = $1 AND c.gym_id = $2 AND c.member_id = $3 FOR UPDATE`,
      [data.charge_id, gymId, memberId]
    );
    if (!chargeRows.length) throw new HttpError(404, 'Charge not found for this member');
    const charge = chargeRows[0];

    const { rows: balanceRows } = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount_cents)::int FROM membership_payments WHERE charge_id = $1), 0)
         - COALESCE((SELECT SUM(f.amount_cents)::int FROM payment_refunds f
                     JOIN membership_payments pay ON pay.id = f.payment_id WHERE pay.charge_id = $1), 0)
       AS net`,
      [charge.id]
    );
    const outstanding = charge.amount_cents - balanceRows[0].net;
    if (amount > outstanding) {
      throw new HttpError(409,
        `Payment exceeds the outstanding balance (₹${(outstanding / 100).toFixed(2)}). Overpayments are not allowed — issue a refund or create a separate charge.`);
    }

    // date boundaries: backdating is allowed, future-dating is not
    if (data.paid_on > charge.today) {
      throw new HttpError(400, 'A payment cannot be dated in the future');
    }

    // currency may not be mixed within a charge
    if (data.currency && data.currency !== charge.currency) {
      throw new HttpError(400, `This charge is in ${charge.currency} — payments must match the charge currency`);
    }

    // duplicate guard: same charge + amount + method + date is almost always
    // a double-entry; explicit force override exists for genuine repeats
    if (!data.allow_duplicate) {
      const { rows: dupes } = await client.query(
        `SELECT id FROM membership_payments
         WHERE charge_id = $1 AND amount_cents = $2 AND method = $3 AND paid_on = $4 LIMIT 1`,
        [charge.id, amount, data.method, data.paid_on]
      );
      if (dupes.length) {
        throw new HttpError(409,
          'An identical payment (same charge, amount, method and date) already exists. Pass allow_duplicate=true if this is genuinely a second identical receipt.');
      }
    }

    // receipt_number gets its final value inside this transaction — the
    // placeholder (needed only for the NOT NULL column) never escapes
    const { rows } = await client.query(
      `INSERT INTO membership_payments
         (gym_id, member_id, charge_id, amount_cents, currency, method, paid_on, receipt_number, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'TMP-' || gen_random_uuid()::text,$8,$9) RETURNING *`,
      [gymId, memberId, charge.id, amount, charge.currency, data.method,
       data.paid_on, data.note ?? null, actor?.userId ?? actor ?? null]
    );
    const payment = rows[0];
    // receipt number is assigned at creation and never changes; immutable
    // rows mean the receipt can be regenerated years later byte-identically
    const receiptNumber = `RCPT-${String(payment.paid_on).replace(/-/g, '')}-${payment.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    await client.query(
      `UPDATE membership_payments SET receipt_number = $2 WHERE id = $1`,
      [payment.id, receiptNumber]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'payment.recorded', entity: 'membership_payment', entityId: payment.id,
      after: { charge_id: charge.id, amount_cents: amount, method: data.method,
               paid_on: data.paid_on, receipt: receiptNumber },
    });
    return getPayment(gymId, payment.id, client);
  });
}

const PAYMENT_SELECT = `
  SELECT p.*,
    COALESCE((SELECT SUM(amount_cents)::int FROM payment_refunds f WHERE f.payment_id = p.id), 0) AS refund_total,
    gm.first_name, gm.last_name, gm.member_code, gm.app_user_id,
    c.description AS charge_description, c.period_start, c.period_end,
    c.amount_cents AS charge_amount_cents, c.due_on,
    mm.plan_name, mm.starts_on AS membership_start, mm.ends_on AS membership_end,
    u.name AS recorded_by_name
  FROM membership_payments p
  JOIN gym_members gm ON gm.id = p.member_id
  JOIN membership_charges c ON c.id = p.charge_id
  LEFT JOIN member_memberships mm ON mm.id = c.membership_id
  LEFT JOIN users u ON u.id = p.recorded_by`;

function paymentStatus(row) {
  let status = 'PAID';
  if (row.refund_total >= row.amount_cents) status = 'REFUNDED';
  else if (row.refund_total > 0) status = 'PARTIAL';
  return { ...row, status };
}

// dbClient: pass the OPEN TRANSACTION client when reading back a row the
// same transaction just inserted — the pool would use another connection
// and not see it yet.
async function getPayment(gymId, paymentId, dbClient = null) {
  const { rows } = dbClient
    ? await dbClient.query(`${PAYMENT_SELECT} WHERE p.gym_id = $1 AND p.id = $2`, [gymId, paymentId])
    : await query(`${PAYMENT_SELECT} WHERE p.gym_id = $1 AND p.id = $2`, [gymId, paymentId]);
  return rows[0] ? paymentStatus(rows[0]) : null;
}

async function listGymPayments(gymId, { q, method, from, to, limit = 50, offset = 0 } = {}) {
  const vals = [gymId];
  const where = ['p.gym_id = $1'];
  if (method) { vals.push(method); where.push(`p.method = $${vals.length}`); }
  if (from) { if (!DATE_RE.test(String(from))) throw new HttpError(400, 'from must be YYYY-MM-DD'); vals.push(from); where.push(`p.paid_on >= $${vals.length}`); }
  if (to) { if (!DATE_RE.test(String(to))) throw new HttpError(400, 'to must be YYYY-MM-DD'); vals.push(to); where.push(`p.paid_on <= $${vals.length}`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(gm.first_name ILIKE $${vals.length} OR gm.last_name ILIKE $${vals.length}
                 OR gm.member_code ILIKE $${vals.length} OR p.receipt_number ILIKE $${vals.length})`);
  }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 50, 200)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `${PAYMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.paid_on DESC, p.created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows.map(paymentStatus);
}

async function listMemberPayments(gymId, memberId) {
  const { rows } = await query(
    `${PAYMENT_SELECT} WHERE p.gym_id = $1 AND p.member_id = $2 ORDER BY p.paid_on DESC, p.created_at DESC`,
    [gymId, memberId]
  );
  return rows.map(paymentStatus);
}

// ── refunds (additive; payments are never edited) ────────────────────────

async function refundPayment(gymId, memberId, paymentId, actor, ip, data, gymAudit) {
  const amount = Number(data.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpError(400, 'amount_cents must be a positive integer amount');
  }
  return transaction(async (client) => {
    const { rows: paymentRows } = await client.query(
      `SELECT * FROM membership_payments WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [paymentId, gymId, memberId]
    );
    if (!paymentRows.length) throw new HttpError(404, 'Payment not found for this member');
    const payment = paymentRows[0];
    const { rows: refundedRows } = await client.query(
      `SELECT COALESCE(SUM(amount_cents)::int, 0) AS total FROM payment_refunds WHERE payment_id = $1`,
      [paymentId]
    );
    const alreadyRefunded = refundedRows[0].total;
    if (alreadyRefunded + amount > payment.amount_cents) {
      throw new HttpError(400,
        `Refund exceeds the payment amount (already refunded ₹${(alreadyRefunded / 100).toFixed(2)} of ₹${(payment.amount_cents / 100).toFixed(2)})`);
    }
    const refundedOn = data.refunded_on || null;
    if (refundedOn && !DATE_RE.test(String(refundedOn))) {
      throw new HttpError(400, 'refunded_on must be a YYYY-MM-DD date');
    }
    const { rows } = await client.query(
      `INSERT INTO payment_refunds (gym_id, payment_id, amount_cents, reason, refunded_on, refunded_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date),$6)
       RETURNING *`,
      [gymId, paymentId, amount, data.reason ?? null, refundedOn, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'payment.refunded', entity: 'membership_payment', entityId: paymentId,
      after: { refund_id: rows[0].id, amount_cents: amount, reason: data.reason ?? null },
    });
    return { refund: rows[0], payment: await getPayment(gymId, paymentId, client) };
  });
}

// ── receipt + dashboard ──────────────────────────────────────────────────

// A receipt is DERIVED from immutable rows — regenerating it years later
// yields byte-identical facts (plan price changes cannot touch it).
async function getReceipt(gymId, paymentId) {
  const payment = await getPayment(gymId, paymentId);
  if (!payment) return null;
  const gym = await query('SELECT name, address_line1, address_line2, city, phone, email FROM gyms WHERE id = $1', [gymId]);
  const g = gym.rows[0] || {};
  return {
    receipt_number: payment.receipt_number,
    gym: {
      name: g.name,
      address: [g.address_line1, g.address_line2, g.city].filter(Boolean).join(', ') || null,
      phone: g.phone, email: g.email,
    },
    member: {
      name: [payment.first_name, payment.last_name].filter(Boolean).join(' '),
      member_code: payment.member_code,
      app_connected: !!payment.app_user_id,
    },
    plan: payment.plan_name || payment.charge_description,
    amount_cents: payment.amount_cents,
    currency: payment.currency,
    date: payment.paid_on,
    method: payment.method,
    covered_period: (payment.period_start && payment.period_end)
      ? { from: payment.period_start, to: payment.period_end }
      : null,
    status: payment.status,
  };
}

async function getBillingSummary(gymId) {
  const revenue = await query(
    `SELECT COALESCE(SUM(p.amount_cents)::int, 0) AS total
     FROM membership_payments p JOIN gyms g ON g.id = p.gym_id
     WHERE p.gym_id = $1
       AND p.paid_on >= date_trunc('month', (now() AT TIME ZONE g.timezone)::date)
       AND p.paid_on < date_trunc('month', (now() AT TIME ZONE g.timezone)::date) + INTERVAL '1 month'`,
    [gymId]
  );
  const collected = await query(
    `SELECT COALESCE((SELECT SUM(amount_cents)::int FROM membership_payments WHERE gym_id = $1), 0)
       - COALESCE((SELECT SUM(f.amount_cents)::int FROM payment_refunds f
                   JOIN membership_payments p ON p.id = f.payment_id WHERE p.gym_id = $1), 0)
     AS total`,
    [gymId]
  );
  // open charges split into due vs overdue using the gym's calendar
  const open = await query(`${CHARGE_SELECT} WHERE c.gym_id = $1`, [gymId]);
  let due = 0;
  let overdue = 0;
  for (const raw of open.rows.map(chargeStatus)) {
    if (['DUE', 'PARTIAL', 'OVERDUE'].includes(raw.status)) {
      if (raw.status === 'OVERDUE') overdue += raw.outstanding_cents;
      else due += raw.outstanding_cents;
    }
  }
  return {
    revenue_this_month: revenue.rows[0].total,
    collected_total: collected.rows[0].total,
    due,
    overdue,
  };
}

// ledger view rows for the Payments dashboard table
async function listChargesForLedger(gymId, { status, q, limit = 50, offset = 0 } = {}) {
  let sql = `${CHARGE_SELECT} WHERE c.gym_id = $1`;
  const vals = [gymId];
  if (q) {
    vals.push(`%${q}%`);
    sql += ` AND (gm.first_name ILIKE $${vals.length} OR gm.last_name ILIKE $${vals.length} OR gm.member_code ILIKE $${vals.length})`;
  }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 50, 200)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(`${sql} ORDER BY c.created_at DESC ${limitSql} ${offsetSql}`, vals);
  const mapped = rows.map(chargeStatus);
  return status ? mapped.filter((r) => r.status === status) : mapped;
}

module.exports = {
  METHODS,
  createChargeForMembership, createManualCharge,
  listMemberCharges, getCharge, listChargesForLedger,
  recordPayment, getPayment, listGymPayments, listMemberPayments,
  refundPayment, getReceipt, getBillingSummary,
};
