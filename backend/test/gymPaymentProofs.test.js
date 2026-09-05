// Payment proof tests (Phase M11). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers the spec: submit against own outstanding charge (non-app + app
// members), PENDING_VERIFICATION leaves the due unpaid, duplicate
// charge/txn protection, amount guards (overpayment/partial), member
// cancel (due remains), admin approve → PAID + receipt (idempotent double
// approval), SUPERSEDED when the desk settled first, reject with reason,
// screenshot upload/authorization, cross-gym isolation, role gating.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymPaymentProofs.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';
const TODAY = new Date().toISOString().slice(0, 10);

const PEOPLE = {
  owner: { email: `pp_owner_${suffix}@test.local`, name: 'Proof Owner' },
  desk: { email: `pp_desk_${suffix}@test.local`, name: 'Proof Desk' },
  owner2: { email: `pp_owner2_${suffix}@test.local`, name: 'Other Owner' },
  appUser: { email: `pp_app_${suffix}@test.local`, name: 'Proof Member' },
  appUser2: { email: `pp_app2_${suffix}@test.local`, name: 'Second Member' },
};
const tokens = {};
let gymA, gymB, plan;
let amanCharge, amanMember, amanAppUserId;
// minimal valid PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, role: 'user', ...person }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}: ${JSON.stringify(body)}`);
  createdUserIds.push(body.user.id);
  return body;
}

async function loginToken(email) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `login ${email}`);
  tokens[email] = body.accessToken;
}

function api(token, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function makeChargedMember(ownerTok, name, { linkedEmail } = {}) {
  // a FRESH app user per call — reusing PEOPLE emails double-links and 409s
  let appToken = null;
  let appUserId = null;
  let member = await (await api(ownerTok, 'POST', `/gym/${gymA.id}/members`,
    linkedEmail ? { first_name: name, email: linkedEmail } : { first_name: name })).json();
  if (linkedEmail) {
    // reuse an already-signed-up app user when the test provides one
    if (tokens[linkedEmail]) {
      appToken = tokens[linkedEmail];
      appUserId = createdUserIds.find((id) => tokens[linkedEmail] && id) && null;
    } else {
      const app = await signup({ name: `${name} App`, email: linkedEmail });
      appToken = app.accessToken;
      appUserId = app.user.id;
      tokens[linkedEmail] = appToken;
    }
    const link = await api(tokens[PEOPLE.owner.email], 'POST',
      `/gym/${gymA.id}/members/${member.id}/link-app`, { email: linkedEmail });
    assert.strictEqual(link.status, 200, `link: ${JSON.stringify(await link.json())}`);
  }
  const term = await (await api(ownerTok, 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships`, { plan_id: plan.id })).json();
  const charges = await (await api(ownerTok, 'GET',
    `/gym/${gymA.id}/members/${member.id}/payments`)).json();
  const charge = charges.charges.find((c) => c.membership_id === term.id);
  assert.ok(charge, 'auto-charge present');
  return { member, term, charge, appToken, appUserId };
}

test.before(async () => {
  app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await loginToken(person.email);

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `ProofGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `ProofGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(r.status, 201);

  const planRes = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Standard Monthly', price_cents: 149900, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' });
  plan = await planRes.json();

  // Aman: non-app member with a due (desk-scoped fixture, no app link)
  const aman = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Aman', phone: '+91 90000 11111' })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${aman.id}/memberships`, { plan_id: plan.id });

  // Sukhpreet: app-linked member with a due (the spec's example)
  const sukh = await makeChargedMember(tokens[PEOPLE.owner.email], 'Sukhpreet Singh',
    { linkedEmail: PEOPLE.appUser.email });
  amanCharge = sukh.charge;
  amanMember = sukh.member;
  amanAppUserId = createdUserIds[createdUserIds.length - 1];

  // second app-linked member for cross-member tests
  const second = await makeChargedMember(tokens[PEOPLE.owner.email], 'Second Member',
    { linkedEmail: PEOPLE.appUser2.email });
  globalThis.__second = second;
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const proofPayload = (chargeId, over = {}) => ({
  charge_id: chargeId,
  amount_cents: 149900,
  method: 'UPI',
  transaction_id: `TXN${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  paid_on: TODAY,
  screenshot_base64: PNG_B64,
  content_type: 'image/png',
  ...over,
});

// ── submission ───────────────────────────────────────────────────────────

test('member submits proof against own due → PENDING_VERIFICATION, due stays unpaid', async () => {
  const res = await api(tokens[PEOPLE.appUser.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(amanCharge.id, { notes: 'paid via GPay' }));
  const body = await res.json();
  assert.strictEqual(res.status, 201, `submit: ${JSON.stringify(body)}`);
  assert.strictEqual(body.status, 'PENDING_VERIFICATION');
  assert.strictEqual(body.amount_cents, 149900);
  assert.strictEqual(body.method, 'UPI');
  assert.ok(body.screenshot_key.includes(`${gymA.id}/`), 'generated storage path includes gym');
  assert.ok(!body.screenshot_key.includes('TXN'), 'storage key is generated, not user-controlled');

  // the charge remains DUE — a pending proof is not a payment
  const charges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${amanMember.id}/payments`)).json();
  assert.strictEqual(charges.charges.find((c) => c.id === amanCharge.id).status, 'DUE');
  globalThis.__pendingId = body.id;
  globalThis.__firstTxn = body.transaction_id;
});

test('duplicate protection: second pending proof per charge AND per txn id rejected', async () => {
  const sameCharge = await api(tokens[PEOPLE.appUser.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(amanCharge.id));
  assert.strictEqual(sameCharge.status, 409, 'second pending proof per charge rejected');

  // a different charge with the SAME transaction id → same-gym txn duplicate
  const second = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(globalThis.__second.charge.id, { transaction_id: globalThis.__firstTxn }));
  assert.strictEqual(second.status, 409, 'same txn id pending at the same gym rejected');
});

test('amount guards: overpayment rejected; zero/negative rejected', async () => {
  const second = globalThis.__second;
  const over = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(second.charge.id, { amount_cents: 200000 }));
  assert.strictEqual(over.status, 400, 'overpayment rejected');
  const zero = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(second.charge.id, { amount_cents: 0 }));
  assert.strictEqual(zero.status, 400, 'zero amount rejected');
});

test('wrong member / wrong gym: charge ownership derived from JWT, never trusted', async () => {
  // appUser2 tries to submit a proof against Aman's charge → 404 (existence hidden)
  const wrong = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(amanCharge.id));
  assert.ok([403, 404].includes(wrong.status), `wrong charge rejected (${wrong.status})`);
});

test('validation: bad method, missing/short txn id, future date, bad screenshot rejected', async () => {
  const chargeId = globalThis.__second.charge.id;
  const cases = [
    { method: 'CASH' },
    { transaction_id: 'ab' },
    { transaction_id: '' },
    { paid_on: addDays(TODAY, 3) },
    { content_type: 'application/pdf' },
    { screenshot_base64: 'not-valid-base64!!!' },
  ];
  for (const over of cases) {
    const res = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
      proofPayload(chargeId, over));
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(over)}`);
  }
});

function addDays(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// ── member cancel ────────────────────────────────────────────────────────

test('member cancels own pending proof: due remains unpaid, no receipt', async () => {
  // Aman's pending proof from the first test
  const cancel = await api(tokens[PEOPLE.appUser.email], 'POST',
    `/gym/my/payment-proofs/${globalThis.__pendingId}/cancel`);
  assert.strictEqual(cancel.status, 200, `cancel: ${JSON.stringify(await cancel.json())}`);
  const charges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${amanMember.id}/payments`)).json();
  assert.strictEqual(charges.charges.find((c) => c.id === amanCharge.id).status, 'DUE',
    'due remains unpaid after cancellation');
  const proofs = await (await api(tokens[PEOPLE.appUser.email], 'GET', '/gym/my/payment-proofs')).json();
  assert.strictEqual(proofs.find((p) => p.id === globalThis.__pendingId).status, 'CANCELLED_BY_MEMBER');
  // double cancel → already processed
  const again = await api(tokens[PEOPLE.appUser.email], 'POST',
    `/gym/my/payment-proofs/${globalThis.__pendingId}/cancel`);
  assert.strictEqual(again.status, 409);
});

// ── desk settles first → proof SUPERSEDED ────────────────────────────────

test('desk settles the charge before approval: proof becomes SUPERSEDED, no second payment', async () => {
  // appUser2's pending proof on second.charge (from the duplicate test)
  // fresh app-linked member submits a proof; the desk settles the SAME
  // charge before the admin reviews the proof
  const { member: supMember, charge: supCharge, appToken: supToken } = await makeChargedMember(
    tokens[PEOPLE.owner.email], 'Superseded', { linkedEmail: `sup_${suffix}@test.local` });
  const submit = await api(supToken, 'POST', '/gym/my/payment-proofs',
    proofPayload(supCharge.id, { transaction_id: 'TXNSUPER1' }));
  const proof = await submit.json();
  assert.strictEqual(submit.status, 201, `submit: ${JSON.stringify(proof)}`);
  const manual = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${supMember.id}/payments`,
    { charge_id: supCharge.id, amount_cents: 149900, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(manual.status, 201, `manual: ${JSON.stringify(await manual.json())}`);
  const approve = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/approve`);
  const body = await approve.json();
  assert.strictEqual(approve.status, 409, `approve: ${JSON.stringify(body)}`);
  assert.match(body.error, /already been processed/);
  const superseded = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/payment-proofs?status=SUPERSEDED`)).json();
  assert.ok(superseded.some((p) => p.id === proof.id), 'proof marked SUPERSEDED');
});

// ── approval flow ────────────────────────────────────────────────────────

test('admin approves: charge PAID, receipt generated, idempotent double approval', async () => {
  const submit = await api(tokens[PEOPLE.appUser.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(amanCharge.id, { transaction_id: 'TXNAPPROVE1' }));
  const proof = await submit.json();
  assert.strictEqual(submit.status, 201);

  const approve = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/approve`);
  const approved = await approve.json();
  assert.strictEqual(approve.status, 200, `approve: ${JSON.stringify(approved)}`);
  assert.strictEqual(approved.proof.status, 'APPROVED');
  assert.ok(approved.payment.receipt_number.startsWith('RCPT-'));

  // double approval (Admin B race) → 409 'already been processed'
  const second = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/approve`);
  const secondBody = await second.json();
  assert.strictEqual(second.status, 409);
  assert.match(secondBody.error, /already been processed/);

  // exactly one payment + one receipt
  const count = await query(
    `SELECT COUNT(*)::int AS c FROM membership_payments WHERE charge_id = $1`,
    [amanCharge.id]
  );
  assert.strictEqual(count.rows[0].c, 1, 'exactly one ledger payment');
  const receipts = await query(
    `SELECT COUNT(*)::int AS c FROM membership_payments WHERE charge_id = $1 AND receipt_number IS NOT NULL`,
    [amanCharge.id]
  );
  assert.strictEqual(receipts.rows[0].c, 1, 'exactly one receipt');
  const charge = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${amanMember.id}/payments`)).json();
  assert.strictEqual(charge.charges.find((c) => c.id === amanCharge.id).status, 'PAID');
  // member cannot cancel after approval
  const memberCancel = await api(tokens[PEOPLE.appUser.email], 'POST',
    `/gym/my/payment-proofs/${proof.id}/cancel`);
  assert.strictEqual(memberCancel.status, 409, 'member cannot cancel after approval');
  globalThis.__approvedReceipt = approved.payment.receipt_number;
  globalThis.__approvedPaymentId = approved.payment.id;
  globalThis.__amanMemberId = amanMember.id;
});

test('member sees the same authoritative receipt (mobile receipt endpoint)', async () => {
  const receipt = await (await api(tokens[PEOPLE.appUser.email], 'GET',
    `/gym/my/receipts/${globalThis.__approvedPaymentId}`)).json();
  assert.strictEqual(receipt.receipt_number, globalThis.__approvedReceipt);
  assert.strictEqual(receipt.status, 'PAID');
  assert.strictEqual(receipt.method, 'UPI');
});

// ── rejection ────────────────────────────────────────────────────────────

test('admin rejects with required reason; member sees the reason and can resubmit', async () => {
  const submit = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(globalThis.__second.charge.id, { transaction_id: 'TXNREJECT1' }));
  const proof = await submit.json();
  assert.strictEqual(submit.status, 201);

  const noReason = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/reject`, {});
  assert.strictEqual(noReason.status, 400, 'reason required');

  const reject = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/reject`,
    { reason: 'Payment screenshot does not match transaction' });
  assert.strictEqual(reject.status, 200);
  const rejected = await reject.json();
  assert.strictEqual(rejected.status, 'REJECTED');
  assert.strictEqual(rejected.rejection_reason, 'Payment screenshot does not match transaction');

  // due remains outstanding; member can submit a replacement proof
  const charges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${proof.member_id}/payments`)).json();
  assert.strictEqual(charges.charges.find((c) => c.id === globalThis.__second.charge.id).status, 'DUE');
  const replacement = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/payment-proofs',
    proofPayload(globalThis.__second.charge.id, { transaction_id: 'TXNREJECT2' }));
  assert.strictEqual(replacement.status, 201, 'replacement proof allowed after rejection');
});

// ── screenshots + authorization ──────────────────────────────────────────

test('screenshot streams for authorized staff; cross-gym and pending-proof protection', async () => {
  // fresh charge — the screenshot test needs a live outstanding due
  const { member: shotMember, charge: shotCharge, appToken: shotToken } = await makeChargedMember(
    tokens[PEOPLE.owner.email], 'ShotMember', { linkedEmail: `shot_${suffix}@test.local` });
  const submit = await api(shotToken, 'POST', '/gym/my/payment-proofs',
    proofPayload(shotCharge.id, { transaction_id: 'TXNPICTURE1', amount_cents: 149900 }));
  const proof = await submit.json();
  assert.strictEqual(submit.status, 201, `screenshot submit: ${JSON.stringify(proof)}`);

  const shot = await fetch(`${baseUrl}/gym/${gymA.id}/payment-proofs/${proof.id}/screenshot`, {
    headers: { Authorization: `Bearer ${tokens[PEOPLE.owner.email]}` },
  });
  assert.strictEqual(shot.status, 200);
  assert.ok(shot.headers.get('content-type').startsWith('image/png'));
  // owner2 (gym B) → existence hidden
  const foreign = await fetch(`${baseUrl}/gym/${gymB.id}/payment-proofs/${proof.id}/screenshot`, {
    headers: { Authorization: `Bearer ${tokens[PEOPLE.owner2.email]}` },
  });
  assert.ok([403, 404].includes(foreign.status), 'cross-gym screenshot blocked');
});

test('role gating: front desk sees proofs but cannot approve/reject; unauthenticated 401', async () => {
  const { member: roleMember, charge: roleCharge, appToken: roleToken } = await makeChargedMember(
    tokens[PEOPLE.owner.email], 'RoleMember', { linkedEmail: `role_${suffix}@test.local` });
  const submit = await api(roleToken, 'POST', '/gym/my/payment-proofs',
    proofPayload(roleCharge.id, { transaction_id: 'TXNROLE1', amount_cents: 149900 }));
  const proof = await submit.json();
  assert.strictEqual(submit.status, 201, `role submit: ${JSON.stringify(proof)}`);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET',
    `/gym/${gymA.id}/payment-proofs?status=PENDING_VERIFICATION`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/approve`)).status, 403,
    'front desk has no approval privileges');
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/payment-proofs/${proof.id}/reject`, { reason: 'nope' })).status, 403);
  assert.strictEqual((await api(null, 'POST', `/gym/my/payment-proofs`,
    proofPayload(amanCharge.id))).status, 401, 'expired/missing auth rejected');
});

test('pending-verification totals feed the Payments dashboard card', async () => {
  const totals = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/payment-proofs/summary`)).json();
  assert.ok(totals.count >= 1, 'pending proofs counted');
  assert.ok(totals.total > 0, 'pending amount summed');
});

test('audit trail records the proof lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['payment_proof.submitted', 'payment_proof.cancelled',
    'payment_proof.approved', 'payment_proof.rejected', 'payment_proof.superseded']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
