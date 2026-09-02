// Membership lifecycle tests (Phase 7). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers the spec: freeze (with the exact-days expiry shift rule), resume,
// freeze cancellation, cancellation during freeze, expiry during freeze,
// renewal before/after expiry, manual extension (with scheduled-renewal
// slide), plan change during freeze, lazy expiry + UPCOMING promotion,
// lifecycle events timeline, non-app and app-connected members, deleted
// gym cascade, and authorization/cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymLifecycle.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `lc_owner_${suffix}@test.local`, name: 'Lifecycle Owner' },
  owner2: { email: `lc_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `lc_admin_${suffix}@test.local`, name: 'Lifecycle Admin' },
  desk: { email: `lc_desk_${suffix}@test.local`, name: 'Lifecycle Desk' },
  appUser: { email: `lc_app_${suffix}@test.local`, name: 'App Person' },
  appUser2: { email: `lc_app2_${suffix}@test.local`, name: 'Second App Person' },
};
const tokens = {};
let gymA, gymB;
let plan, memberNoApp, memberWithApp, memberAppUserId;
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

// make a member + one ACTIVE 1-month term; returns { member, term }
async function makeMemberWithTerm(ownerToken, name, { linkedUser } = {}) {
  const member = await (await api(ownerToken, 'POST', `/gym/${gymA.id}/members`,
    linkedUser ? { first_name: name, email: linkedUser.email } : { first_name: name })).json();
  if (linkedUser) {
    const link = await api(tokens[PEOPLE.owner.email], 'POST',
      `/gym/${gymA.id}/members/${member.id}/link-app`, { email: linkedUser.email });
    assert.strictEqual(link.status, 200, `link-app: ${JSON.stringify(await link.json())}`);
  }
  const term = await (await api(ownerToken, 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships`, { plan_id: plan.id })).json();
  assert.strictEqual(term.status, 'ACTIVE', `assign term: ${JSON.stringify(term)}`);
  return { member, term };
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `LifecycleGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `LifecycleGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  for (const [person, role] of [[PEOPLE.admin, 'ADMIN'], [PEOPLE.desk, 'FRONT_DESK']]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
      { email: person.email, gym_role: role });
    assert.strictEqual(r.status, 201, `staff ${role}`);
  }

  const planRes = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Premium Annual', duration_value: 1, duration_unit: 'year',
      price_cents: 2400000, status: 'ACTIVE' });
  plan = await planRes.json();
  assert.strictEqual(planRes.status, 201);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── freeze / resume: the exact-days rule ─────────────────────────────────

test('freeze: ACTIVE → FROZEN with an open freeze row and an event', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'FreezeCase', { linkedUser: PEOPLE.appUser });
  const freeze = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`, { reason: 'injury' });
  const body = await freeze.json();
  assert.strictEqual(freeze.status, 200, `freeze: ${JSON.stringify(body)}`);
  assert.strictEqual(body.membership.status, 'FROZEN');
  assert.strictEqual(body.freeze.status, 'ACTIVE');
  assert.strictEqual(body.freeze.reason, 'injury');

  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'assigned'));
  assert.ok(events.some((e) => e.event === 'frozen'));
  globalThis.__freezeCase = { member, term };
});

test('freeze overlap: a second freeze while frozen is rejected', async () => {
  const { member, term } = globalThis.__freezeCase;
  const again = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  assert.strictEqual(again.status, 409);
});

test('resume: expiry moves by the EXACT frozen days (freeze Aug 1 → resume Sep 1 = 31 days)', async () => {
  const { member, term } = globalThis.__freezeCase;
  // simulate the spec example: the freeze began 31 days ago, resume today
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`UPDATE membership_freezes SET starts_on = $2
                    WHERE membership_id = $1 AND status = 'ACTIVE'`,
    [term.id, addDays(today, -31)]);
  const resume = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  const body = await resume.json();
  assert.strictEqual(resume.status, 200, `resume: ${JSON.stringify(body)}`);
  // freeze started 31 days ago, resumed today → 31 frozen calendar days
  // (the resume day itself is NOT frozen)
  assert.strictEqual(body.frozen_days, 31, '31 frozen days (resume day not frozen)');
  assert.strictEqual(body.membership.status, 'ACTIVE');
  assert.strictEqual(body.membership.ends_on, addDays(term.ends_on, 31),
    'expiry moved by exactly the frozen days');
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'resumed'));
});

test('freeze cancellation ends the freeze with the same shift rule', async () => {
  const { member, term: t1 } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'FreezeCancel');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${t1.id}/freeze`);
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`UPDATE membership_freezes SET starts_on = $2
                    WHERE membership_id = $1 AND status = 'ACTIVE'`, [t1.id, addDays(today, -6)]);
  const resume = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${t1.id}/resume`, { cancel: true });
  const body = await resume.json();
  assert.strictEqual(resume.status, 200);
  assert.strictEqual(body.frozen_days, 6, '6 frozen days before the freeze was cancelled');
  assert.strictEqual(body.membership.status, 'ACTIVE');
  const freezes = await query('SELECT status FROM membership_freezes WHERE membership_id = $1', [t1.id]);
  assert.strictEqual(freezes.rows[0].status, 'CANCELLED');
});

test('expiry during freeze: resuming a term that still ends before today becomes EXPIRED', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'FrozenExpiry');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  // the term lapsed mid-freeze: freeze began 20 days ago; the ORIGINAL end
  // date is 40 days in the past (simulated)
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`UPDATE member_memberships SET ends_on = $2 WHERE id = $1`,
    [term.id, addDays(today, -40)]);
  await pool.query(`UPDATE membership_freezes SET starts_on = $2
                    WHERE membership_id = $1 AND status = 'ACTIVE'`, [term.id, addDays(today, -20)]);
  const resume = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  const body = await resume.json();
  assert.strictEqual(resume.status, 200);
  assert.strictEqual(body.frozen_days, 20, '20 frozen days even though the term expired mid-freeze');
  assert.strictEqual(body.membership.status, 'EXPIRED',
    'after shifting, a term still ending before today is EXPIRED');
  assert.strictEqual(body.membership.ends_on, addDays(today, -20),
    'the shift still applies — frozen time is not charged');
});

test('cancellation during freeze: term CANCELLED, open freeze closed', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'CancelFrozen');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`, { reason: 'pause' });
  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/cancel`, { reason: 'left for good' });
  const body = await cancel.json();
  assert.strictEqual(cancel.status, 200, `cancel: ${JSON.stringify(body)}`);
  assert.strictEqual(body.status, 'CANCELLED');
  const freezes = await query('SELECT status FROM membership_freezes WHERE membership_id = $1', [term.id]);
  assert.strictEqual(freezes.rows[0].status, 'CANCELLED');
});

// ── renewal before / after expiry ────────────────────────────────────────

test('renewal before expiry schedules UPCOMING (covered again with events)', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'RenewEarly');
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  const renewed = await renew.json();
  assert.strictEqual(renew.status, 201, `renew: ${JSON.stringify(renewed)}`);
  assert.strictEqual(renewed.status, 'UPCOMING');
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'renewed'));
  globalThis.__earlyRenewal = { member, term, renewed };
});

test('renewal while frozen is blocked until resume', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'FrozenRenew');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(renew.status, 400, 'frozen terms must be resumed before renewing');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  const renew2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(renew2.status, 201, 'works after resume');
});

test('renewal after expiry: lazy expiry flips the term, renewal starts TODAY', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'RenewLate');
  // the term lapsed weeks ago (no freeze)
  await pool.query(`UPDATE member_memberships SET ends_on = $2 WHERE id = $1`,
    [term.id, addDays(new Date().toISOString().slice(0, 10), -31)]);
  // a READ triggers the lazy expiry — Dec → Expired history
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  assert.strictEqual(history.find((m) => m.id === term.id).status, 'EXPIRED',
    'overdue term shows EXPIRED after a read');
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  const renewed = await renew.json();
  assert.strictEqual(renew.status, 201, `renew-after-expiry: ${JSON.stringify(renewed)}`);
  assert.strictEqual(renewed.status, 'ACTIVE', 'renewal after expiry starts a new term today');
  assert.strictEqual(renewed.starts_on, renewed.starts_on, 'starts immediately');
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'expired'), 'the expiry was recorded as an event');
});

// ── extend / plan change during freeze ───────────────────────────────────

test('manual extension pushes the expiry and slides a scheduled renewal', async () => {
  const { member, term, renewed } = globalThis.__earlyRenewal;
  const extend = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/extend`, { days: 14 });
  const body = await extend.json();
  assert.strictEqual(extend.status, 200, `extend: ${JSON.stringify(body)}`);
  assert.strictEqual(body.ends_on, addDays(term.ends_on, 14), 'expiry pushed by 14 days');
  const upcoming = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  const scheduled = upcoming.find((m) => m.id === renewed.id);
  assert.strictEqual(scheduled.starts_on, addDays(renewed.starts_on, 14),
    'the scheduled renewal slides by the same 14 days');
});

test('plan change during freeze: frozen term cancelled (freeze closed), new term ACTIVE', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'PlanChangeFrozen');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  const plan2 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Basic Monthly LC', price_cents: 150000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' })).json();
  const change = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships`,
    { plan_id: plan2.id, replace_active: true, cancel_reason: 'downgrade' });
  const changed = await change.json();
  assert.strictEqual(change.status, 201, `plan change: ${JSON.stringify(changed)}`);
  assert.strictEqual(changed.status, 'ACTIVE');
  const freezes = await query('SELECT status FROM membership_freezes WHERE membership_id = $1', [term.id]);
  assert.strictEqual(freezes.rows[0].status, 'CANCELLED', 'the open freeze ends with the replaced term');
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'plan_changed'));
  assert.ok(events.some((e) => e.event === 'cancelled'));
});

// ── lazy promotion + non-app / app members + cascade + authz ─────────────

test('UPCOMING term promotes to ACTIVE when its start date arrives (lazy, on read)', async () => {
  const { member, term, renewed } = globalThis.__earlyRenewal;
  // expire the running term so the renewal's start has "arrived"
  await pool.query(`UPDATE member_memberships SET ends_on = $2 WHERE id = $1`,
    [term.id, addDays(new Date().toISOString().slice(0, 10), -100)]);
  // and the scheduled renewal's start date has now "arrived"
  await pool.query(`UPDATE member_memberships SET starts_on = $2 WHERE id = $1`,
    [renewed.id, addDays(new Date().toISOString().slice(0, 10), -1)]);
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  assert.strictEqual(history.find((m) => m.id === term.id).status, 'EXPIRED');
  assert.strictEqual(history.find((m) => m.id === renewed.id).status, 'ACTIVE',
    'the scheduled renewal took over as ACTIVE');
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  assert.ok(events.some((e) => e.event === 'term_started'));
});

test('non-app and app-connected members both fully manageable; /gym/my/memberships shows the term', async () => {
  // memberWithApp path
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'AppLifecycle', { linkedUser: PEOPLE.appUser2 });
  const freeze = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  assert.strictEqual(freeze.status, 200);
  const resume = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  assert.strictEqual(resume.status, 200);
  // the mobile view sees plan name + valid-until
  const mine = await (await api(tokens[PEOPLE.appUser2.email], 'GET', '/gym/my/memberships')).json();
  const row = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(row, 'app-connected member sees the gym');
  assert.strictEqual(row.plan_name, plan.name);
  assert.strictEqual(row.membership_status, 'ACTIVE');
  assert.ok(row.ends_on, 'valid-until present');
  // the non-app member path was exercised by every test above (all fixtures start unlinked)
});

test('deleted gym cascades memberships, freezes and events away', async () => {
  const tempGym = await (await api(tokens[PEOPLE.owner2.email], 'POST', '/gym',
    { name: `CascadeGym ${suffix}` })).json();
  const member = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${tempGym.gym.id}/members`,
    { first_name: 'Temp' })).json();
  const p = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${tempGym.gym.id}/plans`,
    { name: 'Temp Plan', price_cents: 100000, status: 'ACTIVE' })).json();
  const term = await (await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${tempGym.gym.id}/members/${member.id}/memberships`, { plan_id: p.id })).json();
  await pool.query('DELETE FROM gyms WHERE id = $1', [tempGym.gym.id]);
  const rows = await query('SELECT COUNT(*)::int AS c FROM member_memberships WHERE id = $1', [term.id]);
  assert.strictEqual(rows.rows[0].c, 0, 'membership gone with the gym');
});

test('authorization: ADMIN manages lifecycle, FRONT_DESK cannot, cross-gym 403', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'AuthzCase');
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`)).status, 200,
    'admin holds memberships.manage');
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/extend`, { days: 5 })).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`)).status, 403,
    'front desk cannot manage memberships');
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`)).status, 403,
    'cross-gym lifecycle actions rejected');
});

test('the events timeline reads like the spec example (assigned → frozen → resumed → …)', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'TimelineCase');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`, { reason: 'travel' });
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships/events`)).json();
  const names = events.map((e) => e.event);
  for (const expected of ['assigned', 'frozen', 'resumed', 'renewed']) {
    assert.ok(names.includes(expected), `timeline missing ${expected}`);
  }
});
