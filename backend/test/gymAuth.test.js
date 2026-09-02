// Gym auth/authz/RBAC tests — the security foundation of the Gym Management
// System. Exercises the real routers mounted exactly as server.js mounts
// them, against the real DATABASE_URL, with self-cleaning fixtures.
//
// Covers the spec's edge cases: standalone user, owner/admin/trainer/
// front desk/member roles, inactive + removed staff, multi-gym users,
// cross-gym access, modified IDs, expired authentication, member linking.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymAuth.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

// people in the test scenario
const PEOPLE = {
  owner: { email: `owner_${suffix}@test.local`, name: 'Gym Owner' },
  admin: { email: `admin_${suffix}@test.local`, name: 'Gym Admin' },
  trainer: { email: `trainer_${suffix}@test.local`, name: 'Gym Trainer' },
  desk: { email: `desk_${suffix}@test.local`, name: 'Front Desk' },
  member: { email: `member_${suffix}@test.local`, name: 'Linked Member' },
  standalone: { email: `solo_${suffix}@test.local`, name: 'Standalone User' },
  ownerB: { email: `ownerb_${suffix}@test.local`, name: 'Owner B' },
};
const tokens = {};
let gymA, gymB, adminStaffId, deskStaffId, memberId, linkedMemberId;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}: ${JSON.stringify(body)}`);
  createdUserIds.push(body.user.id);
  return body;
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
  return body.accessToken;
}

function api(token, method, path, body, gymHeader) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(gymHeader ? { 'X-Gym-Id': gymHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) {
    await signup(person);
  }
  for (const person of Object.values(PEOPLE)) {
    await auth(person);
  }

  // Owner creates gym A; second owner creates gym B (cross-gym tests)
  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', {
    name: `GymTest Alpha ${suffix}`, currency: 'INR',
  });
  assert.strictEqual(resA.status, 201);
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);

  const resB = await api(tokens[PEOPLE.ownerB.email], 'POST', '/gym', {
    name: `GymTest Beta ${suffix}`,
  });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  // Owner staffs the gym: ADMIN, TRAINER, FRONT_DESK
  for (const [person, role] of [
    [PEOPLE.admin, 'ADMIN'],
    [PEOPLE.trainer, 'TRAINER'],
    [PEOPLE.desk, 'FRONT_DESK'],
  ]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`, {
      email: person.email, gym_role: role,
    });
    assert.strictEqual(r.status, 201, `add staff ${role}: ${JSON.stringify(await r.json())}`);
  }
  // capture staff ids
  const staffList = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/staff`)).json();
  adminStaffId = staffList.find((s) => s.email === PEOPLE.admin.email)?.id;
  deskStaffId = staffList.find((s) => s.email === PEOPLE.desk.email)?.id;

  // ADMIN creates a member; FRONT_DESK creates a member; one member is later
  // linked to the app account of PEOPLE.member
  const r1 = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gymA.id}/members`, {
    first_name: 'Unlinked', email: `nomad_${suffix}@test.local`,
  });
  assert.strictEqual(r1.status, 201, `admin creates member: ${JSON.stringify(await r1.json())}`);

  const r2 = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/members`, {
    first_name: 'Linked',
  });
  assert.strictEqual(r2.status, 201, `front desk creates member: ${JSON.stringify(await r2.json())}`);
  const members = await (await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/members`)).json();
  memberId = members.find((m) => m.first_name === 'Unlinked')?.id;
  linkedMemberId = members.find((m) => m.first_name === 'Linked')?.id;

  // link the second member to PEOPLE.member's app account (by exact email)
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${linkedMemberId}/link-app`,
    { email: PEOPLE.member.email });
  assert.strictEqual(link.status, 200, `link-app: ${JSON.stringify(await link.json())}`);
});

test.after(async () => {
  // self-cleaning fixtures: remove gyms (cascades staff/members/audit), then users
  for (const id of createdGymIds) {
    await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  }
  for (const id of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── standalone users (spec: no gym required) ─────────────────────────────

test('standalone user: login works with zero gyms and /gym/mine is empty', async () => {
  const mine = await (await api(tokens[PEOPLE.standalone.email], 'GET', '/gym/mine')).json();
  assert.deepStrictEqual(mine, []);
  const memberShips = await (await api(tokens[PEOPLE.standalone.email], 'GET', '/gym/my/memberships')).json();
  assert.deepStrictEqual(memberShips, []);
});

test('standalone user: accessing any gym resource is rejected', async () => {
  const res = await api(tokens[PEOPLE.standalone.email], 'GET', `/gym/${gymA.id}/members`);
  assert.strictEqual(res.status, 403);
});

// ── cross-gym / modified ids (the critical security rule) ────────────────

test('cross-gym: gym A staff cannot read gym B members even with the URL', async () => {
  const res = await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymB.id}/members`);
  assert.strictEqual(res.status, 403);
});

test('cross-gym: gym B owner cannot manage gym A staff', async () => {
  const res = await api(tokens[PEOPLE.ownerB.email], 'GET', `/gym/${gymA.id}/staff`);
  assert.strictEqual(res.status, 403);
});

test('modified gym id (garbage) is rejected, not leaked', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'GET', '/gym/not-a-uuid/members');
  assert.strictEqual(res.status, 400);
});

// ── role matrix ──────────────────────────────────────────────────────────

test('OWNER: full access — settings, staff, members, audit', async () => {
  const t = tokens[PEOPLE.owner.email];
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}`)).status, 200);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/staff`)).status, 200);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/members`)).status, 200);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/audit-log`)).status, 200);
  const patch = await api(t, 'PATCH', `/gym/${gymA.id}`, { city: 'Mumbai' });
  assert.strictEqual(patch.status, 200);
});

test('ADMIN: members/memberships yes; staff, settings, audit no', async () => {
  const t = tokens[PEOPLE.admin.email];
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/members`)).status, 200);
  assert.strictEqual((await api(t, 'PATCH', `/gym/${gymA.id}/members/${memberId}`,
    { phone: '9999999999' })).status, 200);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/staff`)).status, 403);
  assert.strictEqual((await api(t, 'PATCH', `/gym/${gymA.id}`, { city: 'X' })).status, 403);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/audit-log`)).status, 403);
});

test('TRAINER: member lists forbidden (assigned members come with assignments later)', async () => {
  const res = await api(tokens[PEOPLE.trainer.email], 'GET', `/gym/${gymA.id}/members`);
  assert.strictEqual(res.status, 403);
});

test('FRONT_DESK: member lookup + create yes; manage no; staff/settings no', async () => {
  const t = tokens[PEOPLE.desk.email];
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/members`)).status, 200);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/members/${memberId}`)).status, 200);
  assert.strictEqual((await api(t, 'PATCH', `/gym/${gymA.id}/members/${memberId}`,
    { phone: '888' })).status, 403);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/staff`)).status, 403);
  assert.strictEqual((await api(t, 'PATCH', `/gym/${gymA.id}`, { city: 'X' })).status, 403);
});

test('MEMBER (app-linked): sees own membership context; staff resources forbidden', async () => {
  const t = tokens[PEOPLE.member.email];
  const mine = await (await api(t, 'GET', '/gym/my/memberships')).json();
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].gym_id, gymA.id);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/permissions`)).json &&
    (await (await api(t, 'GET', `/gym/${gymA.id}/permissions`)).json()).gymRole, 'MEMBER');
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/members`)).status, 403);
  assert.strictEqual((await api(t, 'GET', `/gym/${gymA.id}/staff`)).status, 403);
});

// ── staff lifecycle: inactive / removed / last-owner protection ──────────

test('removed staff: token immediately loses access (403)', async () => {
  const owner = tokens[PEOPLE.owner.email];
  const remove = await api(owner, 'PATCH', `/gym/${gymA.id}/staff/${deskStaffId}`,
    { status: 'REMOVED' });
  assert.strictEqual(remove.status, 200);
  const res = await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/members`);
  assert.strictEqual(res.status, 403);
  // re-hire for later tests (proves the re-hire path too)
  const rehire = await api(owner, 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(rehire.status, 201);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymA.id}/members`)).status, 200);
});

test('inactive staff: access lost while INACTIVE, restored when ACTIVE', async () => {
  const owner = tokens[PEOPLE.owner.email];
  assert.strictEqual((await api(owner, 'PATCH', `/gym/${gymA.id}/staff/${adminStaffId}`,
    { status: 'INACTIVE' })).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymA.id}/members`)).status, 403);
  assert.strictEqual((await api(owner, 'PATCH', `/gym/${gymA.id}/staff/${adminStaffId}`,
    { status: 'ACTIVE' })).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymA.id}/members`)).status, 200);
});

test('last active owner cannot be demoted or removed', async () => {
  const owner = tokens[PEOPLE.owner.email];
  const ownerId = (await (await api(owner, 'GET', `/gym/${gymA.id}/staff`)).json())
    .find((s) => s.gym_role === 'OWNER').id;
  const demote = await api(owner, 'PATCH', `/gym/${gymA.id}/staff/${ownerId}`, { gym_role: 'FRONT_DESK' });
  assert.strictEqual(demote.status, 400);
  const remove = await api(owner, 'PATCH', `/gym/${gymA.id}/staff/${ownerId}`, { status: 'REMOVED' });
  assert.strictEqual(remove.status, 400);
});

test('staff cannot grant themselves permissions (multi-gym confusion)', async () => {
  // gym A admin tries to act on gym B via X-Gym-Id — the header is not proof
  const res = await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymB.id}/members`, null, gymB.id);
  assert.strictEqual(res.status, 403);
});

// ── member linking edge cases ────────────────────────────────────────────

test('link-app: duplicate user accounts are never created; exact email only', async () => {
  const count = await pool.query(
    `SELECT COUNT(*)::int AS c FROM users WHERE email = $1`,
    [PEOPLE.member.email]
  );
  assert.strictEqual(count.rows[0].c, 1);
  // wrong email → 404, member stays unlinked
  const bad = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberId}/link-app`, { email: 'nobody@nowhere.test' });
  assert.strictEqual(bad.status, 404);
});

test('link-app: a user cannot be linked to two ACTIVE members of the same gym', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberId}/link-app`, { email: PEOPLE.member.email });
  assert.strictEqual(res.status, 409);
});

test('unlinked member (no app account) still has full membership record', async () => {
  const member = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/members/${memberId}`)).json();
  assert.strictEqual(member.app_user_id, null);
  assert.strictEqual(member.status, 'ACTIVE');
});

// ── expired authentication ───────────────────────────────────────────────

test('expired/missing authentication is rejected before any gym logic', async () => {
  assert.strictEqual((await api(null, 'GET', `/gym/${gymA.id}/members`)).status, 401);
  assert.strictEqual((await api('garbage.token.here', 'GET', `/gym/${gymA.id}/members`)).status, 401);
});

// ── audit trail ──────────────────────────────────────────────────────────

test('audit trail records the gym lifecycle (created, staff, member, linked)', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=200`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['gym.created', 'staff.added', 'member.created', 'member.linked_app']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
