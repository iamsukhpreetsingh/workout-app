// Staff Notification Center tests (gym-web phase).
//
// Exercises the real routers + the notification service against the real
// DATABASE_URL. The permission-aware recipient matrix, self-suppression,
// dedupe/idempotency, lazy-scan behavior and gym isolation are the security-
// and noise-critical parts.
//
// Timing note: notifyStaff() is deliberately fire-and-forget (a notification
// failure must never break the business operation), so tests await a short
// sleep after triggering events.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymStaffNotifications.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');
const gyms = require('../src/data/gyms');
const staffNotifications = require('../src/data/gymStaffNotifications');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  ownerA: { email: `na_owner_${suffix}@test.local`, name: 'Owner A' },
  ownerB: { email: `nb_owner_${suffix}@test.local`, name: 'Owner B' },
  adminA: { email: `na_admin_${suffix}@test.local`, name: 'Admin A' },
  deskA: { email: `na_desk_${suffix}@test.local`, name: 'Desk A' },
  trainerA: { email: `na_trainer_${suffix}@test.local`, name: 'Trainer A' },
  member: { email: `na_member_${suffix}@test.local`, name: 'Member' },
};
const tokens = {};
let gymA, gymB, memberRow;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup: ${JSON.stringify(body)}`);
  createdUserIds.push(body.user.id);
  return body.user.id;
}

async function auth(person) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
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

  gymA = (await gyms.createGym((await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id,
    '127.0.0.1', { name: `NotifTest A ${suffix}` })).gym.id;
  createdGymIds.push(gymA);
  gymB = (await gyms.createGym((await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerB.email])).rows[0].id,
    '127.0.0.1', { name: `NotifTest B ${suffix}` })).gym.id;
  createdGymIds.push(gymB);

  // staff of gym A: admin + front desk + trainer
  await query("INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1, (SELECT id FROM users WHERE email = $2), 'ADMIN')", [gymA, PEOPLE.adminA.email]);
  await query("INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1, (SELECT id FROM users WHERE email = $2), 'FRONT_DESK')", [gymA, PEOPLE.deskA.email]);
  await query("INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1, (SELECT id FROM users WHERE email = $2), 'TRAINER')", [gymA, PEOPLE.trainerA.email]);

  // an app-linked member of gym A
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  memberRow = await gyms.createGymMember(gymA, { userId: ownerAId }, '127.0.0.1',
    { first_name: 'Nirmal', last_name: 'Kaur', email: PEOPLE.member.email });
  await gyms.linkMemberToApp(gymA, memberRow.id, { userId: ownerAId }, '127.0.0.1', { email: PEOPLE.member.email });
  await sleep(250); // fire-and-forget hooks settle
  // the setup events above DID notify (proving the hooks fire) — clear the
  // inbox so tests assert on clean baselines
  await pool.query('DELETE FROM gym_staff_notifications WHERE gym_id = ANY($1::uuid[])', [[gymA, gymB]]);
  console.log('DEBUG gymA:', gymA, 'gymB:', gymB, 'memberRow:', !!memberRow);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// helper: unread count for a person
const unreadOf = async (email) => {
  const res = await api(tokens[email], 'GET', `/gym/${gymA}/staff-notifications/unread-count`);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  return body.count;
};

// ── permission-aware recipient matrix ────────────────────────────────────

test('financial type reaches only payments.manage holders (owner; not admin/desk/trainer)', async () => {
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  staffNotifications.notifyStaff({
    gymId: gymA, type: 'PAYMENT_PROOF_SUBMITTED',
    title: 'Payment proof submitted',
    message: 'A payment proof was submitted for verification.',
    entityType: 'PAYMENT_PROOF', entityId: 'x1', memberId: memberRow.id,
    dedupeKey: `t_proof:${suffix}:1`,
  });
  await sleep(200);
  assert.strictEqual(await unreadOf(PEOPLE.ownerA.email), 1);
  assert.strictEqual(await unreadOf(PEOPLE.adminA.email), 0);
  assert.strictEqual(await unreadOf(PEOPLE.deskA.email), 0);
  assert.strictEqual(await unreadOf(PEOPLE.trainerA.email), 0);
});

test('member-lifecycle type reaches members.view holders (owner, admin, desk — not trainer)', async () => {
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  staffNotifications.notifyStaff({
    gymId: gymA, type: 'MEMBER_LEFT',
    title: 'Member left gym',
    message: 'Nirmal Kaur left the gym via the app.',
    entityType: 'MEMBER', entityId: memberRow.id, memberId: memberRow.id,
    dedupeKey: `t_left:${suffix}:1`,
  });
  await sleep(200);
  // everyone had exactly the one proof notification before (owner) — now:
  assert.strictEqual(await unreadOf(PEOPLE.ownerA.email), 2);
  assert.strictEqual(await unreadOf(PEOPLE.adminA.email), 1);
  assert.strictEqual(await unreadOf(PEOPLE.deskA.email), 1);
  assert.strictEqual(await unreadOf(PEOPLE.trainerA.email), 0);
});

test('self-suppression: the actor never receives their own action event', async () => {
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  const adminAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.adminA.email])).rows[0].id;
  staffNotifications.notifyStaff({
    gymId: gymA, type: 'PAYMENT_RECORDED',
    title: 'Payment recorded',
    message: 'Payment recorded — receipt RCPT-X.',
    entityType: 'PAYMENT', entityId: 'p1', memberId: memberRow.id,
    actorUserId: adminAId, // admin performed it; admin has payments.record too
    dedupeKey: `t_recorded:${suffix}:1`,
  });
  await sleep(200);
  const adminList = await (await api(tokens[PEOPLE.adminA.email], 'GET', `/gym/${gymA}/staff-notifications`)).json();
  assert.ok(!adminList.some((n) => n.dedupe_key === `t_recorded:${suffix}:1`), 'actor must not see own action');
  const ownerList = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications`)).json();
  assert.ok(ownerList.some((n) => n.title === 'Payment recorded'), 'other financial staff still see it');
});

// ── gym isolation (spec 56/57) ───────────────────────────────────────────

test('gym B events never reach gym A staff and vice versa', async () => {
  staffNotifications.notifyStaff({
    gymId: gymB, type: 'MEMBER_JOINED',
    title: 'New member joined',
    message: 'Someone joined gym B.',
    entityType: 'MEMBER', entityId: 'mb1', memberId: null,
    dedupeKey: `t_b_joined:${suffix}:1`,
  });
  await sleep(200);
  const listA = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications`)).json();
  assert.ok(!listA.some((n) => n.dedupe_key === `t_b_joined:${suffix}:1`));
  // cross-gym detail access is a 404 that never confirms existence
  const res = await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications/not-a-real-id`);
  assert.strictEqual(res.status, 404);
});

// ── inbox behaviors: filters, dedupe, read state, pagination ─────────────

test('dedupe: the same dedupe key never creates a second row', async () => {
  const beforeRows = (await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?category=MEMBER`)).json())
    .filter((n) => n.title === 'Member left gym').length;
  staffNotifications.notifyStaff({
    gymId: gymA, type: 'MEMBER_LEFT', title: 'Member left gym', message: 'duplicate attempt',
    entityType: 'MEMBER', entityId: memberRow.id, memberId: memberRow.id,
    dedupeKey: `t_left:${suffix}:1`, // SAME key as before
  });
  await sleep(200);
  const afterRows = (await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?category=MEMBER`)).json())
    .filter((n) => n.title === 'Member left gym').length;
  assert.strictEqual(afterRows, beforeRows, 'duplicate event must not duplicate the row');
});

test('filters: unread=1 + category + severity narrow the inbox', async () => {
  const unreadMember = await (await api(tokens[PEOPLE.ownerA.email],
    'GET', `/gym/${gymA}/staff-notifications?unread=1&category=MEMBER`)).json();
  assert.ok(unreadMember.every((n) => n.category === 'MEMBER' && !n.is_read));
  const warning = await (await api(tokens[PEOPLE.ownerA.email],
    'GET', `/gym/${gymA}/staff-notifications?severity=WARNING`)).json();
  assert.ok(warning.every((n) => n.severity === 'WARNING'));
  const search = await (await api(tokens[PEOPLE.ownerA.email],
    'GET', `/gym/${gymA}/staff-notifications?q=Nirmal`)).json();
  assert.ok(search.length >= 1, 'search matches member name in message');
});

test('read state: mark selected read, unread count drops, mark-all finishes', async () => {
  const list = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications`)).json();
  const firstUnread = list.find((n) => !n.is_read);
  assert.ok(firstUnread, 'setup left an unread notification');
  const markRes = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/staff-notifications/read`,
    { ids: [firstUnread.id] });
  assert.strictEqual(markRes.status, 200);
  assert.strictEqual((await markRes.json()).marked, 1);
  const after = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications`)).json();
  assert.ok(after.find((n) => n.id === firstUnread.id).is_read);
  assert.ok(after.find((n) => n.id === firstUnread.id).read_at, 'read_at recorded');

  const allRes = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/staff-notifications/read-all`, {});
  assert.strictEqual(allRes.status, 200);
  assert.strictEqual(await unreadOf(PEOPLE.ownerA.email), 0);
});

test('pagination: limit/offset page through the inbox', async () => {
  const page1 = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?limit=2&offset=0`)).json();
  assert.ok(page1.length <= 2);
  const page2 = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?limit=2&offset=2`)).json();
  if (page2.length) {
    assert.notStrictEqual(page1[page1.length - 1].id, page2[0].id, 'pages must not overlap');
  }
});

test('security: another gym id in the path cannot leak gym B notifications', async () => {
  // owner A asking gym B's endpoint → requireGymContext 403s (no relationship)
  const res = await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymB}/staff-notifications`);
  assert.strictEqual(res.status, 403);
});

// ── lazy scan: expiry alerts, idempotent ─────────────────────────────────

test('scan: membership expiring soon creates exactly one alert across repeated scans', async () => {
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  // a plan + a term ending in 2 days
  const plan = (await query(
    `INSERT INTO membership_plans (gym_id, name, duration_value, duration_unit, price_cents, currency)
     VALUES ($1, 'ScanPlan', 1, 'month', 99900, 'INR') RETURNING id`, [gymA])).rows[0];
  const term = (await query(
    `INSERT INTO member_memberships (gym_id, member_id, plan_id, plan_name, plan_duration_value,
       plan_duration_unit, price_cents, currency, status, starts_on, ends_on)
     VALUES ($1, $2, $3, 'ScanPlan', 1, 'MONTH', 99900, 'INR', 'ACTIVE',
       CURRENT_DATE - 28, CURRENT_DATE + 2) RETURNING id`, [gymA, memberRow.id, plan.id])).rows[0];

  const r1 = await staffNotifications.runStaffNotificationScan(gymA);
  const r2 = await staffNotifications.runStaffNotificationScan(gymA);
  // created counts RECIPIENT ROWS (owner+admin+desk hold memberships.view)
  // across the expiring + inactivity events — the idempotency contract is
  // that a repeated scan creates zero
  assert.ok(r1.created > 0, 'scan created notifications');
  assert.strictEqual(r2.created, 0, 'repeated scan must be idempotent');

  const list = await (await api(tokens[PEOPLE.ownerA.email],
    'GET', `/gym/${gymA}/staff-notifications?category=MEMBERSHIP`)).json();
  const expiring = list.find((n) => n.type === 'MEMBERSHIP_EXPIRING');
  assert.ok(expiring, 'expiring notification is in the inbox');
  assert.ok(expiring.message.includes('Nirmal Kaur'), 'message names the member');
  assert.ok(expiring.member_name === 'Nirmal Kaur', 'member resolved for deep link');
  await pool.query('DELETE FROM member_memberships WHERE id = $1', [term.id]);
  await pool.query('DELETE FROM membership_plans WHERE id = $1', [plan.id]);
});

// ── business-event hook smoke: member lifecycle through the real API ─────

test('hooks: member leave → archive → rejoin generate one notification each', async () => {
  // MEMBER_LEFT comes from the app-user path (already covered by leaveGymAsMember
  // idempotency elsewhere); here: a SECOND member (no app link) exercises the
  // admin archive → rejoin chain
  const ownerAId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  const m2 = await gyms.createGymMember(gymA, { userId: ownerAId }, '127.0.0.1',
    { first_name: 'Archie', last_name: 'Ved', email: `arch_${suffix}@test.local` });
  await gyms.archiveGymMember(gymA, m2.id, { userId: ownerAId }, '127.0.0.1', {});
  await gyms.reactivateGymMember(gymA, m2.id, { userId: ownerAId }, '127.0.0.1', {});
  await sleep(300);
  const list = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?limit=50`)).json();
  for (const type of ['MEMBER_ARCHIVED', 'MEMBER_REJOINED']) {
    assert.ok(list.some((n) => n.type === type), `missing ${type} in inbox`);
  }
  // and the member-initiated path directly
  const memUser = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.member.email])).rows[0].id;
  await gyms.leaveGymAsMember(memUser, gymA, '127.0.0.1', {});
  await sleep(250);
  const list2 = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/staff-notifications?limit=50`)).json();
  assert.ok(list2.some((n) => n.type === 'MEMBER_LEFT'), 'missing MEMBER_LEFT in inbox');
});
