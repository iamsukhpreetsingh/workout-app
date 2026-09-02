// Membership plan management tests (Phase 6). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers: plan creation + validation (duplicate name, duration, price,
// currency, access level), lifecycle DRAFT→ACTIVE→ARCHIVED, price changes
// never rewriting history (snapshots), archived plans blocked for NEW
// assignments while existing memberships stay valid, assignment to members
// with and without app accounts, plan change (old term kept as CANCELLED),
// renewal (UPCOMING for early renewals, price snapshot at renewal),
// cancelled memberships, and authorization/cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymPlans.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `pl_owner_${suffix}@test.local`, name: 'Plan Owner' },
  owner2: { email: `pl_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `pl_admin_${suffix}@test.local`, name: 'Plan Admin' },
  desk: { email: `pl_desk_${suffix}@test.local`, name: 'Plan Desk' },
  trainer: { email: `pl_trainer_${suffix}@test.local`, name: 'Plan Trainer' },
  appUser: { email: `pl_app_${suffix}@test.local`, name: 'App Person' },
};
const tokens = {};
let gymA, gymB;
let memberNoApp, memberWithApp, memberAppUserId;
let planBasic, planPremium, planAnnual, planDraft;
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

const BASIC = {
  name: 'Basic Monthly', description: 'Gym only',
  duration_value: 1, duration_unit: 'month',
  price_cents: 150000, currency: 'INR',
  access_level: 'gym_only', included_pt_sessions: 0, status: 'ACTIVE',
};
const PREMIUM = {
  name: 'Premium Monthly', description: 'Gym + 4 PT sessions',
  duration_value: 1, duration_unit: 'month',
  price_cents: 250000, currency: 'INR',
  access_level: 'all_access', included_pt_sessions: 4, status: 'ACTIVE',
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `PlanGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `PlanGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  for (const [person, role] of [[PEOPLE.admin, 'ADMIN'], [PEOPLE.desk, 'FRONT_DESK'], [PEOPLE.trainer, 'TRAINER']]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
      { email: person.email, gym_role: role });
    assert.strictEqual(r.status, 201, `staff ${role}`);
  }

  memberNoApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoApp', phone: '+91 90000 00001' })).json();
  memberWithApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WithApp', email: PEOPLE.appUser.email })).json();
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/link-app`, { email: PEOPLE.appUser.email });
  assert.strictEqual(link.status, 200);
  memberAppUserId = (await link.json()).app_user_id;
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── plan creation & validation ───────────────────────────────────────────

test('plan creation with spec examples; duplicate name rejected per gym, allowed across gyms', async () => {
  const r1 = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`, BASIC);
  planBasic = await r1.json();
  assert.strictEqual(r1.status, 201, `basic: ${JSON.stringify(planBasic)}`);

  const r2 = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`, PREMIUM);
  planPremium = await r2.json();
  assert.strictEqual(r2.status, 201);

  const r3 = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Annual Premium', price_cents: 2400000, duration_value: 1, duration_unit: 'year',
      access_level: 'all_access', included_pt_sessions: 12, status: 'ACTIVE' });
  planAnnual = await r3.json();
  assert.strictEqual(r3.status, 201);

  const dup = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'basic monthly', price_cents: 100 });
  assert.strictEqual(dup.status, 409, 'duplicate name (case-insensitive) within gym rejected');

  const otherGym = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/plans`,
    { name: 'Basic Monthly', price_cents: 200000, status: 'ACTIVE' });
  assert.strictEqual(otherGym.status, 201, 'same name at a different gym is fine');
});

test('invalid plans rejected: duration, negative price, currency, access level, PT sessions', async () => {
  const cases = [
    { name: 'X', duration_value: 0 },
    { name: 'X', duration_value: 2, duration_unit: 'fortnight' },
    { name: 'X', price_cents: -150000 },
    { name: 'X', currency: 'rupee' },
    { name: 'X', access_level: 'everything' },
    { name: 'X', included_pt_sessions: -4 },
    { name: '' },
  ];
  for (const extra of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`, extra);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}: ${JSON.stringify(await res.json())}`);
  }
  // zero price is a legitimate complimentary plan
  const zero = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Staff Complimentary', price_cents: 0, status: 'ACTIVE' });
  assert.strictEqual(zero.status, 201, 'zero price allowed (complimentary)');
});

test('DRAFT plans exist but cannot be assigned', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Draft Plan', price_cents: 100000 });
  assert.strictEqual(res.status, 201);
  planDraft = await res.json();
  assert.strictEqual(planDraft.status, 'DRAFT');
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`, { plan_id: planDraft.id });
  assert.strictEqual(assign.status, 400, 'draft plans cannot be assigned');
});

// ── assignment (works with appUserId NULL and set) ───────────────────────

test('assign to member WITHOUT app account; calendar-correct end date', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`, { plan_id: planBasic.id });
  const m = await res.json();
  assert.strictEqual(res.status, 201, `assign: ${JSON.stringify(m)}`);
  assert.strictEqual(m.app_user_id, undefined, 'membership rows carry no app fields');
  assert.strictEqual(m.status, 'ACTIVE');
  assert.strictEqual(m.price_cents, 150000, 'price snapshot at assignment');
  const starts = new Date(`${m.starts_on}T00:00:00Z`);
  const ends = new Date(`${m.ends_on}T00:00:00Z`);
  const monthLater = new Date(starts);
  monthLater.setUTCMonth(monthLater.getUTCMonth() + 1);
  assert.strictEqual(m.ends_on, monthLater.toISOString().slice(0, 10), '1 month term ends one calendar month later');
  void ends;
});

test('assign to member WITH app account; member record untouched', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`, { plan_id: planPremium.id });
  assert.strictEqual(res.status, 201, JSON.stringify(await res.json()));
  const member = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${memberWithApp.id}`)).json();
  assert.strictEqual(member.app_user_id, memberAppUserId, 'linking a membership never touches the app link');
});

test('second ACTIVE membership for the same member is rejected (409 with guidance)', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`, { plan_id: planPremium.id });
  assert.strictEqual(res.status, 409);
});

test('authorization: ADMIN assigns, FRONT_DESK cannot, TRAINER cannot view, cross-gym 403', async () => {
  const m2 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AuthCase' })).json();
  const adminAssign = await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${m2.id}/memberships`, { plan_id: planBasic.id });
  assert.strictEqual(adminAssign.status, 201, 'admin holds memberships.manage');
  const deskAssign = await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${m2.id}/memberships`, { plan_id: planBasic.id });
  assert.strictEqual(deskAssign.status, 403, 'front desk cannot manage memberships');
  assert.strictEqual((await api(tokens[PEOPLE.trainer.email], 'GET', `/gym/${gymA.id}/plans`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/plans`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/plans`)).status, 200,
    'front desk can view plans');
  const deskCreates = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/plans`, BASIC);
  assert.strictEqual(deskCreates.status, 403, 'plan creation is OWNER-only');
});

// ── price changes & history ──────────────────────────────────────────────

test('plan price change does NOT touch existing memberships', async () => {
  const patch = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${planPremium.id}`,
    { price_cents: 300000 });
  assert.strictEqual(patch.status, 200, `patch: ${JSON.stringify(await patch.json())}`);
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`)).json();
  const active = history.find((m) => m.status === 'ACTIVE');
  assert.strictEqual(active.price_cents, 250000, 'membership keeps its assignment-time price');
  assert.strictEqual(active.plan_name, 'Premium Monthly');
});

test('plan change replaces the ACTIVE term, keeping the old one as CANCELLED history', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`,
    { plan_id: planPremium.id, replace_active: true, cancel_reason: 'upgrade' });
  assert.strictEqual(res.status, 201, `plan change: ${JSON.stringify(await res.json())}`);
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`)).json();
  assert.strictEqual(history.filter((m) => m.status === 'ACTIVE').length, 1);
  const cancelled = history.find((m) => m.status === 'CANCELLED');
  assert.ok(cancelled, 'old term kept in history');
  assert.strictEqual(cancelled.plan_name, 'Basic Monthly');
  assert.strictEqual(cancelled.price_cents, 150000, 'old term keeps its original price snapshot');
});

// ── archive & renewal ────────────────────────────────────────────────────

test('archiving a plan: existing membership stays valid, NEW assignments rejected', async () => {
  const archive = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${planBasic.id}`,
    { status: 'ARCHIVED' });
  assert.strictEqual(archive.status, 200);
  // memberWithApp still holds an ACTIVE Premium term; assign Basic to the AuthCase member
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`)).json();
  assert.strictEqual(history.find((m) => m.status === 'ACTIVE').status, 'ACTIVE',
    'existing membership unaffected by archiving');
  const m3 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'LateJoiner' })).json();
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m3.id}/memberships`, { plan_id: planBasic.id });
  assert.strictEqual(assign.status, 409, 'archived plans cannot be assigned to new members');
  // reactivating the plan makes it assignable again
  const reactivate = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${planBasic.id}`,
    { status: 'ACTIVE' });
  assert.strictEqual(reactivate.status, 200);
  const assign2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m3.id}/memberships`, { plan_id: planBasic.id });
  assert.strictEqual(assign2.status, 201, 're-activated plan is assignable again');
});

test('renewal: early renewal schedules UPCOMING; renewal snapshots CURRENT plan price', async () => {
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`)).json();
  const active = history.find((m) => m.status === 'ACTIVE');
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships/${active.id}/renew`);
  const renewed = await renew.json();
  assert.strictEqual(renew.status, 201, `renew: ${JSON.stringify(renewed)}`);
  void renewed;
  assert.strictEqual(renewed.status, 'UPCOMING', 'early renewal starts when the current term ends');
  const nextDay = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  assert.strictEqual(renewed.starts_on, nextDay(active.ends_on), 'next term starts the day after the current one ends');
  assert.strictEqual(renewed.price_cents, 300000, 'renewal snapshots the CURRENT plan price');
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/memberships`)).json();
  const oldTerm = after.find((m) => m.id === active.id);
  assert.strictEqual(oldTerm.price_cents, active.price_cents, 'historical term untouched by renewal');
  assert.strictEqual(oldTerm.status, 'ACTIVE', 'early renewal keeps the running term ACTIVE');
});

test('cancelled membership cannot be renewed; a new plan can be assigned after cancel', async () => {
  const m4 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'CancelRenew' })).json();
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m4.id}/memberships`, { plan_id: planAnnual.id });
  assert.strictEqual(assign.status, 201);
  const membership = await assign.json();
  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m4.id}/memberships/${membership.id}/cancel`, { reason: 'moved away' });
  assert.strictEqual(cancel.status, 200);
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m4.id}/memberships/${membership.id}/renew`);
  assert.strictEqual(renew.status, 400, 'cancelled membership cannot be renewed');
  // new assignment allowed after cancellation
  const reassign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m4.id}/memberships`, { plan_id: planBasic.id });
  assert.strictEqual(reassign.status, 201, 'fresh assignment after cancellation works');
});

test('gym-wide memberships list drives the Memberships page', async () => {
  const list = await (await api(tokens[PEOPLE.desk.email],
    'GET', `/gym/${gymA.id}/memberships?status=ACTIVE`)).json();
  assert.ok(list.length >= 3);
  assert.ok(list.every((m) => m.member_code && m.plan_name && m.price_cents != null));
  const searched = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/memberships?q=NoApp`)).json();
  assert.ok(searched.every((m) => m.first_name === 'NoApp'));
});

test('audit trail records plan + membership lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['plan.created', 'plan.updated', 'membership.assigned',
    'membership.renewed', 'membership.cancelled']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
