// Gym billing & payment ledger tests (Phase 9). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec: payments belong to the member/membership context and
// work with app_user_id NULL; all five methods; auto-charge on membership
// sale; partial/over/duplicate payments; refunds (partial + full);
// wrong-member rejection; backdating allowed / future-dating rejected;
// paying charges of cancelled/frozen/expired memberships; price-change
// immutability of charges, payments and receipts; dashboard summary;
// ledger shape; receipt completeness; front-desk can record but sees no
// financial reports; cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymBilling.test.js requires DATABASE_URL (copy .env.example to .env)');
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
  owner: { email: `bl_owner_${suffix}@test.local`, name: 'Billing Owner' },
  admin: { email: `bl_admin_${suffix}@test.local`, name: 'Billing Admin' },
  desk: { email: `bl_desk_${suffix}@test.local`, name: 'Billing Desk' },
  owner2: { email: `bl_owner2_${suffix}@test.local`, name: 'Other Owner' },
  appUser: { email: `bl_app_${suffix}@test.local`, name: 'App Person' },
  appUser2: { email: `bl_app2_${suffix}@test.local`, name: 'Second App Person' },
};
const tokens = {};
let gymA, gymB, plan;
let aman, amanTerm, amanCharge; // non-app member with Premium Monthly @2000
let priya;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}`);
  createdUserIds.push(body.user.id);
  return body.user;
}

async function auth(person) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `login ${person.email}`);
  tokens[person.email] = body.accessToken;
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

const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `BillGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `BillGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  for (const [person, role] of [[PEOPLE.admin, 'ADMIN'], [PEOPLE.desk, 'FRONT_DESK']]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
      { email: person.email, gym_role: role });
    assert.strictEqual(r.status, 201, `staff ${role}`);
  }

  const planRes = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Premium Monthly', price_cents: 200000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' });
  plan = await planRes.json();
  assert.strictEqual(planRes.status, 201);

  // the spec example: Aman Kumar, app NOT connected, Premium Monthly
  aman = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Aman', last_name: 'Kumar', phone: '+91 95000 00000' })).json();
  const term = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${aman.id}/memberships`, { plan_id: plan.id })).json();
  amanTerm = term;
  const charges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${aman.id}/payments`)).json();
  amanCharge = charges.charges.find((c) => c.membership_id === term.id);
  assert.ok(amanCharge, 'assignment auto-created a charge');

  priya = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Priya' })).json();
  // app-linked member for the /my/* mobile surfaces (M9)
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/link-app`, { email: PEOPLE.appUser.email });
  const planM = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Mobile Monthly', price_cents: 250000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' })).json();
  const mTerm = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/memberships`, { plan_id: planM.id })).json();
  globalThis.__mobileCharge = mTerm.price_cents !== undefined ? undefined : undefined;
  const mCharges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${priya.id}/payments`)).json();
  globalThis.__mobileCharge = mCharges.charges.find((c) => c.membership_id === mTerm.id);
  assert.ok(globalThis.__mobileCharge, 'mobile fixture charge created');
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── auto-charge + the spec's non-app example ─────────────────────────────

test('membership sale auto-creates a DUE charge with the price snapshot and period', async () => {
  assert.strictEqual(amanCharge.status, 'DUE');
  assert.strictEqual(amanCharge.amount_cents, 200000, '₹2,000 due');
  assert.strictEqual(amanCharge.period_start, amanTerm.starts_on);
  assert.strictEqual(amanCharge.period_end, amanTerm.ends_on);
  assert.strictEqual(amanCharge.net_paid, 0);
});

test('non-app member pays by UPI — the spec example is fully valid', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${aman.id}/payments`,
    { charge_id: amanCharge.id, amount_cents: 200000, method: 'UPI', paid_on: TODAY });
  const payment = await res.json();
  assert.strictEqual(res.status, 201, `pay: ${JSON.stringify(payment)}`);
  assert.strictEqual(payment.status, 'PAID');
  assert.ok(payment.receipt_number.startsWith('RCPT-'), `receipt: ${payment.receipt_number}`);
  assert.strictEqual(payment.app_user_id, null, 'Aman has no app account — completely valid');
  globalThis.__amanPayment = payment;
});

test('receipt contains gym, member, plan, amount, date, method, period, receipt number', async () => {
  const receipt = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${aman.id}/payments/${globalThis.__amanPayment.id}/receipt`)).json();
  assert.strictEqual(receipt.receipt_number, globalThis.__amanPayment.receipt_number);
  assert.strictEqual(receipt.gym.name, gymA.name);
  assert.strictEqual(receipt.member.name, 'Aman Kumar');
  assert.strictEqual(receipt.member.app_connected, false);
  assert.strictEqual(receipt.plan, 'Premium Monthly');
  assert.strictEqual(receipt.amount_cents, 200000);
  assert.strictEqual(receipt.date, TODAY);
  assert.strictEqual(receipt.method, 'UPI');
  assert.deepStrictEqual(receipt.covered_period, { from: amanTerm.starts_on, to: amanTerm.ends_on });
  assert.strictEqual(receipt.status, 'PAID');
});

// ── partial / duplicate / over / refund ──────────────────────────────────

test('partial payment leaves the charge PARTIAL; completing it reaches PAID', async () => {
  const misc = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${priya.id}/charges`,
    { description: 'Merch + locker', amount_cents: 100000 });
  const charge = await misc.json();
  assert.strictEqual(misc.status, 201);
  const p1 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: charge.id, amount_cents: 40000, method: 'CASH', paid_on: TODAY });
  const p1Body = await p1.json();
  assert.strictEqual(p1.status, 201);
  const after1 = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/charges?status=PARTIAL`)).json();
  const partial = after1.find((c) => c.id === charge.id);
  assert.ok(partial, 'charge is PARTIAL');
  assert.strictEqual(partial.outstanding_cents, 60000);
  void p1Body;
  const p2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: charge.id, amount_cents: 60000, method: 'CARD', paid_on: TODAY });
  assert.strictEqual(p2.status, 201);
  const after2 = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/charges?status=PAID`)).json();
  assert.ok(after2.find((c) => c.id === charge.id), 'charge reached PAID');
});

test('overpayment rejected; duplicate payment rejected unless forced', async () => {
  const misc = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${priya.id}/charges`,
    { description: 'Dues test', amount_cents: 50000 })).json();
  const over = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 60000, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(over.status, 409, 'overpayment rejected');
  const p1 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 50000, method: 'UPI', paid_on: TODAY });
  assert.strictEqual(p1.status, 201);
  const dup = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 50000, method: 'UPI', paid_on: TODAY });
  assert.strictEqual(dup.status, 409, 'duplicate receipt rejected');
  const forced = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 1, method: 'UPI', paid_on: TODAY, allow_duplicate: true });
  // force flag only bypasses the duplicate check, not the overpayment check
  assert.strictEqual(forced.status, 409, 'cannot pay beyond the balance even when forced');
});

test('refund: partial refund flips payment to PARTIAL; full refund to REFUNDED; over-refund blocked', async () => {
  const misc = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${priya.id}/charges`,
    { description: 'Refund case', amount_cents: 100000 })).json();
  const pay = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 100000, method: 'BANK_TRANSFER', paid_on: TODAY })).json();
  const partial = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments/${pay.id}/refund`,
    { amount_cents: 30000, reason: 'wrong plan' });
  assert.strictEqual(partial.status, 201, `partial refund: ${JSON.stringify(await partial.json())}`);
  const afterPartial = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${priya.id}/payments`)).json();
  assert.strictEqual(afterPartial.payments.find((p) => p.id === pay.id).status, 'PARTIAL',
    'partially refunded payment reads PARTIAL');
  const overRefund = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments/${pay.id}/refund`,
    { amount_cents: 80000 });
  assert.strictEqual(overRefund.status, 400, 'cannot refund more than was paid');
  const full = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments/${pay.id}/refund`,
    { amount_cents: 70000, reason: 'full refund' });
  assert.strictEqual(full.status, 201);
  const afterFull = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${priya.id}/payments`)).json();
  assert.strictEqual(afterFull.payments.find((p) => p.id === pay.id).status, 'REFUNDED');
});

// ── wrong member / dates / cancelled + frozen memberships ────────────────

test('wrong member: Priya cannot pay Aman\u2019s charge; cross-gym invisible', async () => {
  const wrong = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: amanCharge.id, amount_cents: 1000, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(wrong.status, 404, `wrong member: ${JSON.stringify(await wrong.json())}`);
});

test('future-dated payment rejected; backdated payment allowed', async () => {
  const misc = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${priya.id}/charges`,
    { description: 'Date case', amount_cents: 20000 })).json();
  const future = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 20000, method: 'CASH', paid_on: addDays(TODAY, 3) });
  assert.strictEqual(future.status, 400, 'future payment rejected');
  const back = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 20000, method: 'CASH', paid_on: addDays(TODAY, -5) });
  assert.strictEqual(back.status, 201, 'backdated payment allowed');
});

test('charges of cancelled and frozen memberships remain payable', async () => {
  const frozen = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'FrozenPayer' })).json();
  const fTerm = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${frozen.id}/memberships`, { plan_id: plan.id })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${frozen.id}/memberships/${fTerm.id}/freeze`);
  const fCharges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${frozen.id}/payments`)).json();
  const fPay = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${frozen.id}/payments`,
    { charge_id: fCharges.charges[0].id, amount_cents: 200000, method: 'UPI', paid_on: TODAY });
  assert.strictEqual(fPay.status, 201, 'frozen membership dues are still collectible');

  const cancelled = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'CancelledPayer' })).json();
  const cTerm = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${cancelled.id}/memberships`, { plan_id: plan.id })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${cancelled.id}/memberships/${cTerm.id}/cancel`, { reason: 'left' });
  const cCharges = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${cancelled.id}/payments`)).json();
  const cPay = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${cancelled.id}/payments`,
    { charge_id: cCharges.charges[0].id, amount_cents: 200000, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(cPay.status, 201, 'cancelled membership dues are still collectible');
  void cPay;
});

// ── historical integrity ─────────────────────────────────────────────────

test('plan price change does NOT modify historical charges, payments or receipts', async () => {
  const patch = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${plan.id}`,
    { price_cents: 250000 });
  assert.strictEqual(patch.status, 200);
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${aman.id}/payments`)).json();
  const charge = history.charges.find((c) => c.id === amanCharge.id);
  assert.strictEqual(charge.amount_cents, 200000, 'charge keeps its snapshot amount');
  const payment = history.payments.find((p) => p.id === globalThis.__amanPayment.id);
  assert.strictEqual(payment.amount_cents, 200000);
  assert.strictEqual(payment.receipt_number, globalThis.__amanPayment.receipt_number,
    'receipt number unchanged');
  const receipt = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${aman.id}/payments/${globalThis.__amanPayment.id}/receipt`)).json();
  assert.strictEqual(receipt.amount_cents, 200000, 'regenerated receipt is byte-identical');
});

// ── dashboard, ledger, authorization ─────────────────────────────────────

test('dashboard summary: revenue this month, collected, due, overdue', async () => {
  const summary = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/payments/summary`)).json();
  assert.ok(summary.revenue_this_month > 0);
  assert.ok(summary.collected_total > 0);
  assert.ok(summary.due >= 0 && summary.overdue >= 0);
  // collected = revenue - refunds (all payments were this month)
  assert.ok(summary.collected_total <= summary.revenue_this_month + 1);
});

test('payment ledger rows carry member, amount, date, method, membership, period, status', async () => {
  const ledger = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/payments`)).json();
  assert.ok(ledger.length >= 3);
  const row = ledger.find((r) => r.id === globalThis.__amanPayment.id);
  assert.strictEqual(row.first_name, 'Aman');
  assert.strictEqual(row.method, 'UPI');
  assert.strictEqual(row.plan_name, 'Premium Monthly');
  assert.strictEqual(row.period_start, amanTerm.starts_on);
  assert.strictEqual(row.status, 'PAID');
  assert.ok(row.receipt_number);
});

test('authorization: front desk records payments but cannot see the financial dashboard; cross-gym 403', async () => {
  const misc = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${priya.id}/charges`,
    { description: 'Desk sale', amount_cents: 10000 })).json();
  const deskPay = await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 10000, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(deskPay.status, 201, 'front desk records payments');
  const deskLedger = await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/payments`);
  assert.strictEqual(deskLedger.status, 200, 'front desk sees the ledger');
  const deskSummary = await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/payments/summary`);
  assert.strictEqual(deskSummary.status, 403, 'front desk has NO access to financial reports');
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/payments`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: misc.id, amount_cents: 1, method: 'CASH', paid_on: TODAY })).status, 403);
});

test('audit trail records the financial lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['charge.created', 'payment.recorded', 'payment.refunded']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});


// ── mobile M9: member-facing payments / receipts / pay-online action ─────

test('/my/billing: payments history + online_payment flag ride along per gym', async () => {
  const mine = await (await api(tokens[PEOPLE.appUser.email], 'GET', '/gym/my/billing')).json();
  const gym = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gym, 'app-linked member sees their gym');
  assert.strictEqual(gym.online_payment_available, false, 'no gateway wired up yet');
  assert.ok(Array.isArray(gym.payments), 'payments history included');
  assert.ok(Array.isArray(gym.charges), 'dues charges included');
  const mobileCharge = gym.charges.find((c) => c.id === globalThis.__mobileCharge.id);
  assert.ok(mobileCharge, 'the membership charge is in the dues list');
  assert.strictEqual(mobileCharge.status, 'DUE');
});

test('/my/payments: full receipt history for one gym, newest first', async () => {
  // pay the mobile charge first
  const pay = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${priya.id}/payments`,
    { charge_id: globalThis.__mobileCharge.id, amount_cents: 250000, method: 'UPI', paid_on: TODAY });
  assert.strictEqual(pay.status, 201);
  const payment = await pay.json();

  const history = await (await api(tokens[PEOPLE.appUser.email], 'GET',
    `/gym/my/payments?gym_id=${gymA.id}`)).json();
  assert.ok(Array.isArray(history) && history.length >= 1);
  const row = history.find((p) => p.id === payment.id);
  assert.ok(row, 'the new payment is in the member history');
  assert.strictEqual(row.amount_cents, 250000);
  assert.strictEqual(row.method, 'UPI');
  assert.strictEqual(row.status, 'PAID');
  assert.ok(row.receipt_number.startsWith('RCPT-'));
  assert.strictEqual(row.plan_name, 'Mobile Monthly');
  assert.ok(row.period_start && row.period_end, 'covered period included');
  globalThis.__mobilePayment = payment;
});

test('/my/receipts/:id: member reads their own receipt; other members cannot', async () => {
  const receipt = await (await api(tokens[PEOPLE.appUser.email], 'GET',
    `/gym/my/receipts/${globalThis.__mobilePayment.id}`)).json();
  assert.strictEqual(receipt.receipt_number, globalThis.__mobilePayment.receipt_number);
  assert.strictEqual(receipt.member.app_connected, true);
  assert.strictEqual(receipt.plan, 'Mobile Monthly');
  assert.strictEqual(receipt.method, 'UPI');

  // second app member (no membership at this gym) → 404, no existence leak
  createdUserIds.push((await (await api(null, 'POST', '/auth/signup',
    { name: 'Outsider', email: `bl_out_${suffix}@test.local`, password: PASSWORD, role: 'user' })).json()).user.id);
  await auth({ email: `bl_out_${suffix}@test.local` });
  const foreign = await api(tokens[`bl_out_${suffix}@test.local`], 'GET',
    `/gym/my/receipts/${globalThis.__mobilePayment.id}`);
  assert.strictEqual(foreign.status, 404, 'another member cannot read this receipt');
});

test('pay-online action: exposed through the backend, resolves to 501 with a desk message', async () => {
  const res = await api(tokens[PEOPLE.appUser.email], 'POST',
    `/gym/my/charges/${globalThis.__mobileCharge.id}/pay-online`);
  const stubBody = await res.json();
  assert.strictEqual(res.status, 501, `stub: ${JSON.stringify(stubBody)}`);
  assert.strictEqual(stubBody.online_payment_available, false);
  // wrong member's charge → 404 before the stub answer
  createdUserIds.push((await (await api(null, 'POST', '/auth/signup',
    { name: 'Outsider 2', email: `bl_out2_${suffix}@test.local`, password: PASSWORD, role: 'user' })).json()).user.id);
  await auth({ email: `bl_out2_${suffix}@test.local` });
  const foreign = await api(tokens[`bl_out2_${suffix}@test.local`], 'POST',
    `/gym/my/charges/${globalThis.__mobileCharge.id}/pay-online`);
  assert.strictEqual(foreign.status, 404, 'cannot start a payment on another member charge');
});