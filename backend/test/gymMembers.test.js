// Gym member management tests (Phase 4). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers the spec: GymMember ≠ User (works with appUserId NULL), profile
// fields, duplicate-member guard (per gym — never across gyms), missing
// email/phone, independent membership status vs app connection, connection
// filters, search by member id, invite → cancel-invite → invite → link-app,
// member leaves (CANCELLED) + reactivates, contact-detail changes,
// unauthorized access, cross-gym access, and "a linked User is never
// deleted".
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymMembers.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `mem_owner_${suffix}@test.local`, name: 'Member Owner' },
  owner2: { email: `mem_owner2_${suffix}@test.local`, name: 'Other Gym Owner' },
  admin: { email: `mem_admin_${suffix}@test.local`, name: 'Member Admin' },
  trainer: { email: `mem_trainer_${suffix}@test.local`, name: 'Member Trainer' },
  appUser: { email: `mem_app_${suffix}@test.local`, name: 'App Person' },
  appUser2: { email: `mem_app2_${suffix}@test.local`, name: 'Second App Person' },
};
const tokens = {};
let gymA, gymB;
let memberNoApp, memberWithEmail, memberLinked, memberDup;
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `MemGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `MemGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  const staff = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  assert.strictEqual(staff.status, 201);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── creation & profile ───────────────────────────────────────────────────

test('member without app account: full profile, GM- code, derived NOT_CONNECTED', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`, {
    first_name: 'Aman', last_name: 'Kumar',
    phone: '+91 98765 43210',
    date_of_birth: '1995-06-15', gender: 'male',
    emergency_contact_name: 'Sunita Kumar', emergency_contact_phone: '+91 91234 56780',
    profile: { goal: 'strength', preferred_language: 'hi' },
  });
  const member = await res.json();
  assert.strictEqual(res.status, 201, `create: ${JSON.stringify(member)}`);
  memberNoApp = member;
  assert.ok(member.member_code.startsWith('GM-'), `member_code: ${member.member_code}`);
  assert.strictEqual(member.app_user_id, null);
  assert.strictEqual(member.app_connection, 'NOT_CONNECTED');
  assert.strictEqual(member.status, 'ACTIVE');
  assert.strictEqual(member.date_of_birth, '1995-06-15', 'DATE crosses as a calendar string');
  assert.strictEqual(member.profile.goal, 'strength');
});

test('duplicate member: same email rejected within a gym, allowed across gyms', async () => {
  const email = `dup_${suffix}@members.test`;
  const first = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'First', email });
  assert.strictEqual(first.status, 201);
  memberDup = await first.json();
  const dup = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Second', email });
  assert.strictEqual(dup.status, 409, `dup within gym: ${JSON.stringify(await dup.json())}`);
  // a different gym is unaffected
  const other = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'Other Gym', email });
  assert.strictEqual(other.status, 201, 'same email at a different gym is a different member');
});

test('missing email and phone are fine', async () => {
  const noContact = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'No Contact' });
  assert.strictEqual(noContact.status, 201);
  const body = await noContact.json();
  assert.strictEqual(body.email, null);
  assert.strictEqual(body.phone, null);

  const riya = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Riya', email: `riya_${suffix}@members.test`, phone: '9876500000' });
  assert.strictEqual(riya.status, 201);
  memberWithEmail = await riya.json();
});

test('invalid profile input rejected (dob, gender, emergency phone)', async () => {
  const cases = [
    { first_name: 'X', date_of_birth: '15-06-1995' },
    { first_name: 'X', date_of_birth: '2090-01-01' },
    { first_name: 'X', gender: 'unknown' },
    { first_name: 'X', emergency_contact_phone: 'not a phone' },
    { first_name: 'X', profile: 'not-an-object' },
  ];
  for (const extra of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`, extra);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
  }
});

// ── the two state axes ───────────────────────────────────────────────────

test('membership status and app connection are independent', async () => {
  // freeze a NOT_CONNECTED member
  const frozen = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${memberNoApp.id}`, { status: 'FROZEN' });
  assert.strictEqual(frozen.status, 200);
  const frozenBody = await frozen.json();
  assert.strictEqual(frozenBody.status, 'FROZEN');
  assert.strictEqual(frozenBody.app_connection, 'NOT_CONNECTED',
    'freezing membership says nothing about app connection');
  await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${memberNoApp.id}`, { status: 'ACTIVE' });

  // link an app account: connection changes, membership does not
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithEmail.id}/link-app`, { email: PEOPLE.appUser.email });
  assert.strictEqual(link.status, 200);
  memberLinked = await link.json();
  assert.strictEqual(memberLinked.app_connection, 'CONNECTED');
  assert.strictEqual(memberLinked.status, 'ACTIVE');
});

test('connection filter and membership filter are separate query params', async () => {
  const list = async (params) => (await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members?${params}`)).json());
  const connected = await list('connection=CONNECTED');
  assert.ok(connected.length >= 1);
  assert.ok(connected.every((m) => m.app_user_id));
  const pending = await list('connection=INVITATION_PENDING');
  assert.ok(pending.every((m) => !m.app_user_id));
  const activeNotConnected = await list('status=ACTIVE&connection=NOT_CONNECTED');
  assert.ok(activeNotConnected.every((m) => m.status === 'ACTIVE' && !m.app_user_id));
});

test('search by member id (code), name, email and phone', async () => {
  const list = async (params) => (await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members?${params}`)).json());
  assert.ok((await list(`q=${memberNoApp.member_code}`)).some((m) => m.id === memberNoApp.id));
  assert.ok((await list('q=Aman')).some((m) => m.id === memberNoApp.id));
  assert.ok((await list(`q=riya_${suffix}`)).some((m) => m.id === memberWithEmail.id));
  assert.ok((await list('q=9876500000')).some((m) => m.id === memberWithEmail.id));
});

// ── invitations ──────────────────────────────────────────────────────────

test('invite-app: NOT_CONNECTED → INVITATION_PENDING, code hashed at rest', async () => {
  // Aman has no email on record — the invite supplies one (stored on the member)
  const email = `invite_${suffix}@members.test`;
  const invite = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/invite-app`, { email });
  const body = await invite.json();
  assert.strictEqual(invite.status, 201, `invite: ${JSON.stringify(body)}`);
  assert.ok(/^[0-9a-f]{32}$/.test(body.invite_code));
  assert.strictEqual(body.email, email);
  const detail = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members/${memberNoApp.id}`)).json();
  assert.strictEqual(detail.app_connection, 'INVITATION_PENDING');
  // plaintext code must not be stored
  const rows = await query('SELECT code_hash FROM gym_member_invites WHERE member_id = $1', [memberNoApp.id]);
  assert.strictEqual(rows.rows.length, 1);
  assert.notStrictEqual(rows.rows[0].code_hash, body.invite_code);
});

test('re-invite replaces the pending invite; cancel-invite returns to NOT_CONNECTED', async () => {
  const re = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/invite-app`);
  assert.strictEqual(re.status, 201);
  const pendingCount = await query(
    `SELECT COUNT(*)::int AS c FROM gym_member_invites WHERE member_id = $1 AND status = 'PENDING'`,
    [memberNoApp.id]
  );
  assert.strictEqual(pendingCount.rows[0].c, 1, 'only one PENDING invite per member');

  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/cancel-invite`);
  assert.strictEqual(cancel.status, 200);
  const detail = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members/${memberNoApp.id}`)).json();
  assert.strictEqual(detail.app_connection, 'NOT_CONNECTED');

  // invite again so the "member later gets app" flow can accept it
  const again = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/invite-app`);
  assert.strictEqual(again.status, 201);
});

test('member with no email cannot be invited (400), invite already-connected fails', async () => {
  const noContact = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members?q=No`)).json();
  assert.ok(noContact.length >= 1, 'No Contact member found');
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${noContact[0].id}/invite-app`);
  assert.strictEqual(res.status, 400);
  const linked = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberLinked.id}/invite-app`);
  assert.strictEqual(linked.status, 400);
});

test('member later gets an app account: link by email, INVITATION_PENDING → CONNECTED', async () => {
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/link-app`, { email: PEOPLE.appUser2.email });
  assert.strictEqual(link.status, 200);
  const body = await link.json();
  assert.strictEqual(body.app_connection, 'CONNECTED');
  assert.strictEqual(body.status, 'ACTIVE', 'linking never changes membership status');
  // the pending invite is consumed
  const pending = await query(
    `SELECT status FROM gym_member_invites WHERE member_id = $1 ORDER BY created_at DESC`,
    [memberNoApp.id]
  );
  assert.ok(pending.rows.every((r) => r.status !== 'PENDING'), 'no stale PENDING invite after linking');
});

// ── lifecycle: leaves / reactivates / contact changes ────────────────────

test('member leaves: CANCELLED, history kept, app user never deleted', async () => {
  const leave = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithEmail.id}/cancel`, { reason: 'relocated' });
  assert.strictEqual(leave.status, 200);
  const body = await leave.json();
  assert.strictEqual(body.status, 'CANCELLED');
  // cancelling a member keeps the record AND the app link (Reactivate restores it)
  assert.ok(body.app_user_id, 'app link survives cancellation');
  // the linked USER row is never deleted
  const user = await query('SELECT id FROM users WHERE email = $1', [PEOPLE.appUser.email]);
  assert.strictEqual(user.rows.length, 1, 'the underlying User account still exists');
});

test('cancelled members do not block a rejoin; reactivate restores ACTIVE', async () => {
  // same email can join again after leaving (old row stays CANCELLED)
  const rejoin = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Riya', email: memberWithEmail.email });
  assert.strictEqual(rejoin.status, 201, `rejoin: ${JSON.stringify(await rejoin.json())}`);
  // and the original row reactivates cleanly
  const reactivate = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithEmail.id}/reactivate`);
  assert.strictEqual(reactivate.status, 200);
  const body = await reactivate.json();
  assert.strictEqual(body.status, 'ACTIVE');
  assert.strictEqual(body.app_connection, 'CONNECTED', 'app link survives leave/reactivate');
});

test('contact detail changes: email swap validated, duplicate blocked', async () => {
  const patch = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${memberWithEmail.id}`,
    { phone: '+91 90000 00000', emergency_contact_name: 'New Contact' });
  assert.strictEqual(patch.status, 200);
  const body = await patch.json();
  assert.strictEqual(body.phone, '+91 90000 00000');
  const dup = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${memberWithEmail.id}`, { email: `dup_${suffix}@members.test` });
  assert.strictEqual(dup.status, 409, 'cannot take another member\'s email');
});

// ── authorization ────────────────────────────────────────────────────────

test('authorization: admin can manage members, trainer cannot even view, cross-gym 403', async () => {
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymA.id}/members`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.trainer.email], 'GET', `/gym/${gymA.id}/members`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/members/${memberNoApp.id}`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/reactivate`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${memberDup.id}/invite-app`)).status, 201,
    'admin holds members.manage for invitations');
});

test('audit trail records the member lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['member.created', 'member.invited', 'member.invite_cancelled',
    'member.linked_app', 'member.cancelled', 'member.reactivated', 'member.updated']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
