// Gym member-home dashboard tests (Mobile M5). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the M5 contract:
//  - GET /gym/my/trainer  → one row per app-linked member row; the ACTIVE
//    trainer assignment (name/email/since) or nulls; JWT-resolved only
//  - GET /gym/my/billing  → per-gym dues derived SERVER-side (DUE / PARTIAL
//    / OVERDUE / PAID flow, outstanding + overdue totals, next due date);
//    no other member's charges; a staff user with no member rows gets []
//  - GET /gym/my/memberships now surfaces an EXPIRED term (plan + expiry
//    date) and the open freeze row (starts_on + reason) for FROZEN — the
//    raw material for the dashboard's EXPIRED/FROZEN displays. Dues and
//    trainer history stay visible after expiry (history is never hidden).
//  - auth required; cross-member isolation
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymMyDashboard.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';
const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const YESTERDAY = addDays(TODAY, -1);

const PEOPLE = {
  owner: { email: `dh_owner_${suffix}@test.local`, name: 'Dashboard Owner' },
  trainer: { email: `dh_trainer_${suffix}@test.local`, name: 'Rohit Sharma' },
  memberUser: { email: `dh_member_${suffix}@test.local`, name: 'Dashboard Member' },
};
const tokens = {};
let gymA, gymB, plan, memberA, memberB, termA, chargeA, trainerStaffId;
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

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);
  const ownerToken = tokens[PEOPLE.owner.email];

  // one owner, two gyms — the dashboard is multi-gym safe
  gymA = (await (await api(ownerToken, 'POST', '/gym', { name: `DashGym A ${suffix}` })).json()).gym;
  gymB = (await (await api(ownerToken, 'POST', '/gym', { name: `DashGym B ${suffix}` })).json()).gym;
  createdGymIds.push(gymA.id, gymB.id);

  // gym A staff: a TRAINER to assign
  const staffRes = await api(ownerToken, 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.trainer.email, gym_role: 'TRAINER' });
  assert.strictEqual(staffRes.status, 201, `staff: ${staffRes.status}`);
  trainerStaffId = (await staffRes.json()).id;
  assert.ok(trainerStaffId, 'staff row has an id');

  // plan + member A (app-linked below) + membership sale (auto-charge)
  const planRes = await api(ownerToken, 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Dashboard Monthly', price_cents: 200000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' });
  plan = await planRes.json();
  assert.strictEqual(planRes.status, 201);

  memberA = await (await api(ownerToken, 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Dashboard', last_name: 'Member', email: PEOPLE.memberUser.email })).json();
  memberB = await (await api(ownerToken, 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'Dashboard', last_name: 'Member B', email: PEOPLE.memberUser.email })).json();

  // link the app account (the invitation bridge does this via the API; the
  // fixture shortcut writes the same column the accept flow writes)
  const userId = (await pool.query('SELECT id FROM users WHERE email = $1', [PEOPLE.memberUser.email])).rows[0].id;
  await pool.query('UPDATE gym_members SET app_user_id = $1 WHERE id = $2', [userId, memberA.id]);
  await pool.query('UPDATE gym_members SET app_user_id = $1 WHERE id = $2', [userId, memberB.id]);

  termA = await (await api(ownerToken, 'POST',
    `/gym/${gymA.id}/members/${memberA.id}/memberships`, { plan_id: plan.id })).json();
  assert.ok(termA.id, 'membership term created');

  const charges = await (await api(ownerToken, 'GET',
    `/gym/${gymA.id}/members/${memberA.id}/payments`)).json();
  chargeA = charges.charges.find((c) => c.membership_id === termA.id);
  assert.ok(chargeA, 'assignment auto-created a charge');

  // trainer for member A at gym A
  const tr = await api(ownerToken, 'POST', `/gym/${gymA.id}/members/${memberA.id}/trainer`,
    { trainer_staff_id: trainerStaffId });
  assert.strictEqual(tr.status, 201, `trainer assign: ${tr.status}`);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const memberToken = () => tokens[PEOPLE.memberUser.email];
const ownerToken = () => tokens[PEOPLE.owner.email];

// ── auth ───────────────────────────────────────────────────────────────────

test('my surfaces require authentication', async () => {
  assert.strictEqual((await api(null, 'GET', '/gym/my/trainer')).status, 401);
  assert.strictEqual((await api(null, 'GET', '/gym/my/billing')).status, 401);
});

// ── /my/memberships: term visibility for the dashboard ─────────────────────

test('memberships: ACTIVE term with plan and expiry; term-less gym has nulls', async () => {
  const rows = await (await api(memberToken(), 'GET', '/gym/my/memberships')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  const b = rows.find((r) => r.gym_id === gymB.id);
  assert.strictEqual(a.membership_status, 'ACTIVE');
  assert.strictEqual(a.plan_name, 'Dashboard Monthly');
  assert.strictEqual(a.ends_on, termA.ends_on);
  assert.ok(a.gym_phone !== undefined && a.gym_email !== undefined, 'contact columns ride along');
  assert.strictEqual(b.member_code, memberB.member_code);
  assert.strictEqual(b.membership_status, null, 'no term sold at gym B');
  assert.strictEqual(b.plan_name, null);
});

test('memberships: FROZEN term carries the open freeze row (starts_on + reason)', async () => {
  const fr = await api(ownerToken(), 'POST',
    `/gym/${gymA.id}/members/${memberA.id}/memberships/${termA.id}/freeze`,
    { reason: 'knee surgery' });
  assert.strictEqual(fr.status, 200, `freeze: ${fr.status}`);

  const rows = await (await api(memberToken(), 'GET', '/gym/my/memberships')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.membership_status, 'FROZEN');
  assert.strictEqual(a.freeze_starts_on, TODAY);
  assert.strictEqual(a.freeze_reason, 'knee surgery');

  // resume → ACTIVE again, freeze fields drop off
  const rs = await api(ownerToken(), 'POST',
    `/gym/${gymA.id}/members/${memberA.id}/memberships/${termA.id}/resume`, {});
  assert.strictEqual(rs.status, 200, `resume: ${rs.status}`);
  const after = (await (await api(memberToken(), 'GET', '/gym/my/memberships')).json())
    .find((r) => r.gym_id === gymA.id);
  assert.strictEqual(after.membership_status, 'ACTIVE');
  assert.strictEqual(after.freeze_starts_on, null);
  assert.strictEqual(after.freeze_reason, null);
});

test('memberships: EXPIRED term stays visible with plan and expiry date', async () => {
  await pool.query(
    `UPDATE member_memberships SET status = 'EXPIRED', ends_on = $2, updated_at = now() WHERE id = $1`,
    [termA.id, YESTERDAY]
  );
  const rows = await (await api(memberToken(), 'GET', '/gym/my/memberships')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.membership_status, 'EXPIRED', 'expired term is surfaced, not hidden');
  assert.strictEqual(a.plan_name, 'Dashboard Monthly');
  assert.strictEqual(a.ends_on, YESTERDAY);
  assert.strictEqual(a.freeze_starts_on, null);
});

// ── /my/billing: server-derived dues ───────────────────────────────────────

test('billing: fresh sale reads DUE with full outstanding', async () => {
  const rows = await (await api(memberToken(), 'GET', '/gym/my/billing')).json();
  assert.strictEqual(rows.length, 1, 'gym B has no charges — absent, not zeroed');
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.gym_name, gymA.name);
  assert.strictEqual(a.currency, 'INR');
  assert.strictEqual(a.outstanding_cents, 200000);
  assert.strictEqual(a.overdue_cents, 0);
  assert.strictEqual(a.charges[0].status, 'DUE');
  assert.strictEqual(a.charges[0].outstanding_cents, 200000);
  assert.ok(a.charges[0].description.includes('Dashboard Monthly'));
  assert.strictEqual(a.charges[0].first_name, undefined, 'no member PII in the member surface');
});

test('billing: partial payment → PARTIAL with reduced outstanding', async () => {
  const pay = await api(ownerToken(), 'POST', `/gym/${gymA.id}/members/${memberA.id}/payments`,
    { charge_id: chargeA.id, amount_cents: 50000, method: 'CASH', paid_on: TODAY });
  assert.strictEqual(pay.status, 201);
  const a = (await (await api(memberToken(), 'GET', '/gym/my/billing')).json())
    .find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.outstanding_cents, 150000);
  assert.strictEqual(a.charges[0].status, 'PARTIAL');
});

test('billing: backdated manual charge is OVERDUE; totals and next due date line up', async () => {
  const fine = await api(ownerToken(), 'POST', `/gym/${gymA.id}/members/${memberA.id}/charges`,
    { description: 'Locker fine', amount_cents: 80000, due_on: YESTERDAY });
  assert.strictEqual(fine.status, 201);
  const a = (await (await api(memberToken(), 'GET', '/gym/my/billing')).json())
    .find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.outstanding_cents, 230000);
  assert.strictEqual(a.overdue_cents, 80000);
  assert.strictEqual(a.next_due_on, YESTERDAY);
  // open dues sort earliest-due-first: the overdue fine comes before the term charge
  assert.strictEqual(a.charges[0].description, 'Locker fine');
  assert.strictEqual(a.charges[0].status, 'OVERDUE');
});

test('billing: settling the term charge leaves only the overdue fine outstanding', async () => {
  const pay = await api(ownerToken(), 'POST', `/gym/${gymA.id}/members/${memberA.id}/payments`,
    { charge_id: chargeA.id, amount_cents: 150000, method: 'UPI', paid_on: TODAY });
  assert.strictEqual(pay.status, 201);
  const a = (await (await api(memberToken(), 'GET', '/gym/my/billing')).json())
    .find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.outstanding_cents, 80000);
  assert.strictEqual(a.overdue_cents, 80000);
  const paid = a.charges.find((c) => c.id === chargeA.id);
  assert.strictEqual(paid.status, 'PAID');
  assert.strictEqual(paid.outstanding_cents, 0);
  assert.ok(a.charges.some((c) => c.id === chargeA.id), 'settled charge stays visible as history');
});

test('billing: dues survive an EXPIRED term (history is never hidden)', async () => {
  // termA was expired by the memberships test above
  const rows = await (await api(memberToken(), 'GET', '/gym/my/billing')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.ok(a, 'expired member still sees their dues');
  assert.strictEqual(a.outstanding_cents, 80000);
});

test('billing: only MY charges — a desk-added charge for another member is invisible', async () => {
  // a member row with NO app account gets a charge; the app-linked member
  // must not see it
  const other = await (await api(ownerToken(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Other', last_name: 'Member' })).json();
  await api(ownerToken(), 'POST', `/gym/${gymA.id}/members/${other.id}/charges`,
    { description: 'Someone else\u2019s merch', amount_cents: 99900 });
  const rows = await (await api(memberToken(), 'GET', '/gym/my/billing')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.ok(!a.charges.some((c) => c.description.includes('Someone else')), 'cross-member isolation');
  assert.strictEqual(a.outstanding_cents, 80000);
});

test('billing/trainer: a staff user with no member rows gets []', async () => {
  assert.deepStrictEqual(await (await api(ownerToken(), 'GET', '/gym/my/billing')).json(), []);
  assert.deepStrictEqual(await (await api(ownerToken(), 'GET', '/gym/my/trainer')).json(), []);
});

// ── /my/trainer: the ACTIVE assignment ─────────────────────────────────────

test('trainer: ACTIVE assignment surfaces name + since; other gym is null', async () => {
  const rows = await (await api(memberToken(), 'GET', '/gym/my/trainer')).json();
  assert.strictEqual(rows.length, 2, 'one row per app-linked member row');
  const a = rows.find((r) => r.gym_id === gymA.id);
  const b = rows.find((r) => r.gym_id === gymB.id);
  assert.strictEqual(a.trainer_name, 'Rohit Sharma');
  assert.strictEqual(a.trainer_email, PEOPLE.trainer.email);
  assert.ok(a.assignment_id, 'live assignment id present');
  assert.strictEqual(b.trainer_name, null, 'gym B has no trainer — explicit null, not a missing row');
});

test('trainer: stays visible after the term expires (assignment is member-scoped)', async () => {
  const rows = await (await api(memberToken(), 'GET', '/gym/my/trainer')).json();
  const a = rows.find((r) => r.gym_id === gymA.id);
  assert.strictEqual(a.trainer_name, 'Rohit Sharma');
});

// ── Mobile M6 — the member attendance experience ───────────────────────────

const HEX_RE = /^[0-9a-f]{32}$/;

test('checkin-code: staff can issue (get-or-create) and rotate the posted QR code', async () => {
  const first = await (await api(ownerToken(), 'GET', `/gym/${gymB.id}/attendance/checkin-code`)).json();
  assert.strictEqual(first.checkin_code.length, 32, '128-bit secret');
  assert.match(first.checkin_code, HEX_RE, 'lowercase hex, not a guessable gym id');

  // get-or-create is stable — reprinting the poster never rotates the code
  const again = await (await api(ownerToken(), 'GET', `/gym/${gymB.id}/attendance/checkin-code`)).json();
  assert.strictEqual(again.checkin_code, first.checkin_code);

  // rotate → brand-new code (old printed copies stop working)
  const rot = await (await api(ownerToken(), 'POST', `/gym/${gymB.id}/attendance/checkin-code/rotate`, {})).json();
  assert.strictEqual(rot.status !== undefined ? rot.status : 200, 200);
  assert.match(rot.checkin_code, HEX_RE);
  assert.notStrictEqual(rot.checkin_code, first.checkin_code);
  global.__codeB = rot.checkin_code;
});

test('checkin-code: auth and role gates (member of the gym cannot manage codes)', async () => {
  assert.strictEqual((await api(null, 'GET', `/gym/${gymB.id}/attendance/checkin-code`)).status, 401);
  assert.strictEqual((await api(null, 'POST', `/gym/${gymB.id}/attendance/checkin-code/rotate`, {})).status, 401);
  // the member IS a gym_member row here, but MEMBER holds no checkin.manage
  assert.strictEqual((await api(memberToken(), 'GET', `/gym/${gymB.id}/attendance/checkin-code`)).status, 403);
});

test('member QR check-in: happy path, then a re-scan reconciles (never double-counts)', async () => {
  // member B holds no membership term at gym B — the Phase-10 ledger rule
  // admits term-less members (trial / day visitor), same as the desk scan
  const first = await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: global.__codeB });
  assert.strictEqual(first.status, 201, `first scan: ${first.status}`);
  const body = await first.json();
  assert.strictEqual(body.gym_id, gymB.id);
  assert.strictEqual(body.gym_name, gymB.name);
  assert.strictEqual(body.source, 'QR_CHECK_IN');
  assert.strictEqual(body.duplicate, false);
  assert.ok(body.attendance.id, 'visit recorded');
  assert.ok(body.attendance.local_date, 'gym-local date derived server-side');

  // tap/scan again → the SAME visit comes back, honestly flagged
  const second = api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: global.__codeB });
  const again = await second;
  assert.strictEqual(again.status, 200, 'idempotent re-scan is 200, not a new 201');
  const dup = await again.json();
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(dup.attendance.id, body.attendance.id, 'one visit = one record');
});

test('member QR check-in: unknown, short and missing codes all answer 404 identically', async () => {
  assert.strictEqual((await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: 'nosuchcode1234' })).status, 404);
  assert.strictEqual((await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: 'ab' })).status, 404);
  assert.strictEqual((await api(memberToken(), 'POST', '/gym/my/attendance/check-in', {})).status, 404);
  assert.strictEqual((await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: null })).status, 404);
  // and the full poster payload form works too (prefix stripped server-side)
  const payload = await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: `gymcheckin:v1:${global.__codeB}` });
  assert.strictEqual(payload.status, 200, 'payload form resolves to the same gym');
  assert.strictEqual((await payload.json()).duplicate, true);
});

test('member QR check-in: a code from a gym the caller does not belong to is 403; suspended gym 404s', async () => {
  // a third gym the member is NOT linked to
  const gymC = (await (await api(ownerToken(), 'POST', '/gym', { name: `DashGym C ${suffix}` })).json()).gym;
  createdGymIds.push(gymC.id);
  const codeC = (await (await api(ownerToken(), 'GET', `/gym/${gymC.id}/attendance/checkin-code`)).json()).checkin_code;

  const foreign = await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: codeC });
  assert.strictEqual(foreign.status, 403, 'never records a visit at a foreign gym');
  assert.match((await foreign.json()).error, /another gym/);

  // suspended gym → its code stops resolving entirely (no information leak)
  const deact = await api(ownerToken(), 'POST', `/gym/${gymC.id}/deactivate`, {});
  assert.strictEqual(deact.status, 200, `deactivate: ${deact.status}`);
  assert.strictEqual((await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: codeC })).status, 404);
});

test('member QR check-in: EXPIRED membership is rejected by the strict source rule', async () => {
  // termA was expired by the memberships tests above; gym A now issues a code
  const codeA = (await (await api(ownerToken(), 'GET', `/gym/${gymA.id}/attendance/checkin-code`)).json()).checkin_code;
  const res = await api(memberToken(), 'POST', '/gym/my/attendance/check-in', { code: codeA });
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /expired/, 'the rejection names the reason');
});

test('attendance history: ?days widens the window; rows carry the gym-local today', async () => {
  // default window stays 90 (back-compat)
  const def = await (await api(memberToken(), 'GET', '/gym/my/attendance/history')).json();
  const defB = def.find((r) => r.gym_id === gymB.id);
  assert.strictEqual(defB.history.length, 90);
  assert.match(defB.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(defB.history[0].date, defB.today, 'the calendar starts at the gym-local today');
  assert.strictEqual(defB.history[0].present, true, "today's QR visit shows ✓");
  assert.strictEqual(defB.history[0].source, 'QR_CHECK_IN');

  // widened window: 365 days for the month-by-month view
  const wide = await (await api(memberToken(), 'GET', '/gym/my/attendance/history?days=365')).json();
  const wideB = wide.find((r) => r.gym_id === gymB.id);
  assert.strictEqual(wideB.history.length, 365);
  assert.strictEqual(wideB.history[wideB.history.length - 1].present, false, 'oldest row is a plain − day');

  // clamped: absurd values stay inside sane bounds
  const tiny = await (await api(memberToken(), 'GET', '/gym/my/attendance/history?days=1')).json();
  assert.strictEqual(tiny.find((r) => r.gym_id === gymB.id).history.length, 7, 'floor of 7 days');
  const huge = await (await api(memberToken(), 'GET', '/gym/my/attendance/history?days=99999')).json();
  assert.strictEqual(huge.find((r) => r.gym_id === gymB.id).history.length, 365, 'ceiling of 365 days');
});
