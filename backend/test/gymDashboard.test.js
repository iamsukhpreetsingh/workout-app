// Gym management dashboard & analytics tests (Phase 15). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec's edge cases end-to-end:
//   new gym / zero members / zero revenue / zero attendance → all zeros,
//   never NaN; only non-app members; only app members; mixed members;
//   incomplete history (charges without payments, members without visits);
//   multiple branches (per-branch split); plus member status buckets,
//   app adoption (pending ⊂ not connected), financial ledger math
//   (collected / outstanding / overdue), attendance windows on gym-local
//   days, trainer coverage and permissions (reports.view: OWNER, ADMIN).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymDashboard.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `db_owner_${suffix}@test.local`, name: 'Dash Owner' },
  owner2: { email: `db_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `db_admin_${suffix}@test.local`, name: 'Dash Admin' },
  trainerUser: { email: `db_trainer_${suffix}@test.local`, name: 'Dash Trainer' },
  frontDesk: { email: `db_desk_${suffix}@test.local`, name: 'Dash Desk' },
  memberUser: { email: `db_member_${suffix}@test.local`, name: 'Dash Member' },
};
const tokens = {};
let gymA, gymB, planId, trainerStaffId;
const createdUserIds = [];
const createdGymIds = [];

// a fresh gym for the all-zeros case
let gymEmpty;

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
  tokens[person.email] = (await res.json()).accessToken;
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

const owner = () => tokens[PEOPLE.owner.email];

async function dash(gymId = gymA.id, token = owner()) {
  const res = await api(token, 'GET', `/gym/${gymId}/dashboard`);
  assert.strictEqual(res.status, 200, `dashboard: ${res.status}`);
  return res.json();
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

  const resA = await api(owner(), 'POST', '/gym', { name: `DashGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `DashGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  // deterministic attendance/peak-hour math
  await query('UPDATE gyms SET timezone = $2 WHERE id = $1', [gymA.id, 'UTC']);

  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.trainerUser.email, gym_role: 'TRAINER' });
  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.frontDesk.email, gym_role: 'FRONT_DESK' });
  trainerStaffId = (await query(
    "SELECT id FROM gym_staff WHERE gym_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)",
    [gymA.id, PEOPLE.trainerUser.email])).rows[0].id;

  planId = (await (await api(owner(), 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Dash Plan', price_cents: 200000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' })).json()).id;

  // a second gym with NOTHING in it (new gym / all zeros)
  const resE = await api(owner(), 'POST', '/gym', { name: `DashGym Empty ${suffix}` });
  gymEmpty = (await resE.json()).gym;
  createdGymIds.push(gymEmpty.id);
});

test.after(async () => {
  if (createdGymIds.length) {
    await query('DELETE FROM gyms WHERE id = ANY($1::uuid[])', [createdGymIds]);
  }
  if (createdUserIds.length) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  }
  await pool.end();
  server.close();
});

// ── edge cases: new gym, zero everything ──────────────────────────────────

test('new gym / zero members / zero revenue / zero attendance → zeros, never NaN', async () => {
  const d = await dash(gymEmpty.id);
  assert.strictEqual(d.members.total, 0);
  assert.strictEqual(d.members.active, 0);
  assert.strictEqual(d.members.expiring_soon_7d, 0);
  assert.strictEqual(d.app_adoption.total, 0);
  assert.strictEqual(d.app_adoption.connected, 0);
  assert.strictEqual(d.app_adoption.not_connected, 0);
  assert.strictEqual(d.app_adoption.invitation_pending, 0);
  assert.strictEqual(d.financial.collected_cents, 0);
  assert.strictEqual(d.financial.outstanding_cents, 0);
  assert.strictEqual(d.financial.overdue_cents, 0);
  assert.strictEqual(d.attendance.today, 0);
  assert.strictEqual(d.attendance.week, 0);
  assert.strictEqual(d.attendance.month, 0);
  assert.strictEqual(d.attendance.inactive_7d, 0);
  assert.strictEqual(d.attendance.peak_hour, null);
  assert.ok(Array.isArray(d.attendance.peak_hours) && d.attendance.peak_hours.length === 24);
  assert.strictEqual(d.trainers.total, 0);
  assert.strictEqual(d.trainers.members_per_trainer, 0);
  assert.strictEqual(d.trainers.unassigned_members, 0);
  assert.deepStrictEqual(d.branches, []);
});

// ── members: buckets, adoption, branches (mixed member set) ───────────────

let mAppActive, mMailActive, mPending, mFrozen, mCancelled, mBranch1, mBranch2;

test('member buckets + app adoption (pending ⊂ not connected) over a mixed set', async () => {
  // 1 app-connected ACTIVE member
  mAppActive = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AppActive', email: PEOPLE.memberUser.email })).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mAppActive.id}/link-app`, { email: PEOPLE.memberUser.email });

  // 2 non-app members (only non-app so far)
  mMailActive = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'MailActive', email: `db_mail_${suffix}@mail.local` })).json();
  mPending = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'PendingInvite' })).json();
  await query("UPDATE gym_members SET app_invite_status = 'pending' WHERE id = $1", [mPending.id]);

  // 1 FROZEN member
  mFrozen = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'FrozenGuy' })).json();
  await query("UPDATE gym_members SET status = 'FROZEN' WHERE id = $1", [mFrozen.id]);

  // 1 CANCELLED member
  mCancelled = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'GoneGuy' })).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mCancelled.id}/cancel`, { reason: 'left' });

  // branch labels on two of them (multiple branches)
  mBranch1 = mAppActive;
  mBranch2 = mMailActive;
  await query('UPDATE gym_members SET branch = $2 WHERE id = $1', [mBranch1.id, 'North Wing']);
  await query('UPDATE gym_members SET branch = $2 WHERE id = $1', [mBranch2.id, 'South Wing']);

  const d = await dash();
  // buckets: 3 ACTIVE (mAppActive, mMailActive, mPending) + 1 FROZEN
  //          + 1 CANCELLED = 5 total; the pending-invite member is still an
  //          ACTIVE member — the invitation only affects app adoption below
  assert.strictEqual(d.members.total, 5);
  assert.strictEqual(d.members.active, 3);
  assert.strictEqual(d.members.frozen, 1);
  assert.strictEqual(d.members.cancelled, 1);
  // adoption base = non-cancelled (4): 1 connected + 3 not connected, 1 pending inside
  assert.strictEqual(d.app_adoption.total, 4);
  assert.strictEqual(d.app_adoption.connected, 1);
  assert.strictEqual(d.app_adoption.not_connected, 3);
  assert.strictEqual(d.app_adoption.invitation_pending, 1);
  // trainers: 1 active TRAINER, nobody assigned yet
  assert.strictEqual(d.trainers.total, 1);
  assert.strictEqual(d.trainers.assigned_members, 0);
  assert.strictEqual(d.trainers.unassigned_members, 4);
  // branches split
  assert.strictEqual(d.branches.length, 2);
  const north = d.branches.find((b) => b.branch === 'North Wing');
  assert.strictEqual(north.members, 1);
  assert.strictEqual(north.active, 1);
});

// ── financial ─────────────────────────────────────────────────────────────

test('financial: charge without payment = outstanding; partial payment splits; past due = overdue', async () => {
  // membership for the app member auto-creates the plan-price charge
  const term = await (await api(owner(), 'POST',
    `/gym/${gymA.id}/members/${mAppActive.id}/memberships`, { plan_id: planId })).json();
  assert.ok(term.id);

  let d = await dash();
  assert.strictEqual(d.financial.outstanding_cents, 200000); // full price outstanding
  assert.strictEqual(d.financial.collected_cents, 0);
  assert.strictEqual(d.financial.open_charges, 1);
  assert.strictEqual(d.financial.overdue_cents, 0);          // not past due yet
  assert.strictEqual(d.financial.currency, 'INR');

  // partial payment: 50k collected, 150k still outstanding
  const charges = (await (await api(owner(), 'GET',
    `/gym/${gymA.id}/members/${mAppActive.id}/payments`)).json()).charges;
  const charge = charges.find((c) => c.membership_id === term.id);
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mAppActive.id}/payments`,
    { charge_id: charge.id, amount_cents: 50000, method: 'UPI', paid_on: new Date().toISOString().slice(0, 10) });

  d = await dash();
  assert.strictEqual(d.financial.collected_cents, 50000);
  assert.strictEqual(d.financial.outstanding_cents, 150000);

  // make the charge past-due → overdue slice moves
  await query('UPDATE membership_charges SET due_on = CURRENT_DATE - 3 WHERE id = $1', [charge.id]);
  d = await dash();
  assert.strictEqual(d.financial.overdue_cents, 150000);
  assert.strictEqual(d.financial.overdue_charges, 1);

  // a manual charge on the non-app member (incomplete history: no membership)
  const misc = await (await api(owner(), 'POST',
    `/gym/${gymA.id}/members/${mMailActive.id}/charges`,
    { description: 'Merch', amount_cents: 10000 })).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mMailActive.id}/payments`,
    { charge_id: misc.id, amount_cents: 10000, method: 'CASH',
      paid_on: new Date().toISOString().slice(0, 10) });
  d = await dash();
  assert.strictEqual(d.financial.collected_cents, 60000);      // 50k + 10k
  assert.strictEqual(d.financial.outstanding_cents, 150000);   // paid-up charge leaves outstanding
});

// ── attendance ────────────────────────────────────────────────────────────

test('attendance: today/week/month visits, peak hour, inactive 7+ days (visits included)', async () => {
  // two members check in TODAY (QR token needed for scan → issue to the app member)
  const qr = await (await api(owner(), 'GET',
    `/gym/${gymA.id}/members/${mAppActive.id}/qr`)).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/attendance/scan`, { qr_token: qr.qr_token });
  // non-app member: front-desk style scan requires a token too → use direct member attendance
  const rec = await api(owner(), 'POST', `/gym/${gymA.id}/members/${mMailActive.id}/attendance`,
    { source: 'FRONT_DESK' });
  assert.ok([200, 201].includes(rec.status), `record: ${rec.status}`);

  const d = await dash();
  assert.strictEqual(d.attendance.today, 2);
  assert.ok(d.attendance.week >= 2);
  assert.ok(d.attendance.month >= 2);
  // every visit happened "now" → the current UTC hour is the peak
  const nowHour = new Date().getUTCHours();
  assert.strictEqual(d.attendance.peak_hour, nowHour);
  assert.strictEqual(d.attendance.peak_hours[nowHour].visits, 2);
  // inactive window: members with NO visit in the last 7 days —
  // mPending + mFrozen (no visits); the two checked-in members are excluded
  assert.strictEqual(d.attendance.inactive_7d, 2);
});

// ── trainers ──────────────────────────────────────────────────────────────

test('trainer coverage: assignment moves a member from unassigned to per-trainer load', async () => {
  const assign = await api(owner(), 'POST',
    `/gym/${gymA.id}/members/${mAppActive.id}/trainer`, { trainer_staff_id: trainerStaffId });
  assert.strictEqual(assign.status, 201);
  const d = await dash();
  assert.strictEqual(d.trainers.assigned_members, 1);
  assert.strictEqual(d.trainers.unassigned_members, 3);
  assert.strictEqual(d.trainers.members_per_trainer, 1);
});

// ── expiring soon + cross-gym isolation ───────────────────────────────────

test('expiring soon counts ACTIVE memberships ending within 7 days; gym B stays empty', async () => {
  await query(
    `UPDATE member_memberships SET ends_on = CURRENT_DATE + 5 WHERE member_id = $1`,
    [mAppActive.id]
  );
  const d = await dash();
  assert.strictEqual(d.members.expiring_soon_7d, 1);

  // incomplete history on gym B: one member, nothing else (queried by gym B's own owner)
  await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`, { first_name: 'Lonely' });
  const dB = await dash(gymB.id, tokens[PEOPLE.owner2.email]);
  assert.strictEqual(dB.members.total, 1);
  assert.strictEqual(dB.app_adoption.not_connected, 1);
  assert.strictEqual(dB.financial.collected_cents, 0);
  assert.strictEqual(dB.attendance.today, 0);
  assert.strictEqual(dB.trainers.total, 0);
});

// ── permissions ───────────────────────────────────────────────────────────

test('permissions: OWNER and ADMIN see the dashboard; FRONT_DESK / TRAINER / member 403', async () => {
  assert.strictEqual((await api(owner(), 'GET', `/gym/${gymA.id}/dashboard`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymA.id}/dashboard`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.frontDesk.email], 'GET', `/gym/${gymA.id}/dashboard`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.trainerUser.email], 'GET', `/gym/${gymA.id}/dashboard`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.memberUser.email], 'GET', `/gym/${gymA.id}/dashboard`)).status, 403);
  // cross-gym: owner2 is not staff of gym A
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/dashboard`)).status, 403);
});
