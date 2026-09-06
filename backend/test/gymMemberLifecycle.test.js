// Member LEAVE / REJOIN lifecycle tests (multi-gym phase).
//
// Exercises the real routers against the real DATABASE_URL:
//   - user-initiated leave  (POST /gym/my/memberships/:gymId/leave)
//   - admin archive         (POST /gym/:gymId/members/:id/archive)
//   - rejoin                (reactivate → SAME member identity + history)
//   - gates after leaving   (gym context 403s, LEFT not an active member)
//   - multi-gym isolation   (leaving gym A leaves gym B untouched)
//   - audit trail           (member.left_by_user / removed_by_admin / rejoined)
//
// Not covered here but enforced server-side (see the data layer): LEFT
// members cannot submit payment proofs (gymPaymentProofs.submitProof) or
// record attendance (gymAttendance.eligibility), and announcements exclude
// LEFT members from audiences (gymCommunications).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymMemberLifecycle.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  ownerA: { email: `ownera_${suffix}@test.local`, name: 'Owner A' },
  ownerB: { email: `ownerb_${suffix}@test.local`, name: 'Owner B' },
  member: { email: `member_${suffix}@test.local`, name: 'Multi Gym Member' },
};
const tokens = {};
let gymA, gymB, memberRowA, memberRowB;
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

// owner creates a gym + a member row linked to PEOPLE.member's app account
async function setupGymWithMember(ownerEmail, gymName) {
  const created = await api(tokens[ownerEmail], 'POST', '/gym', { name: gymName, currency: 'INR' });
  assert.strictEqual(created.status, 201);
  const gym = (await created.json()).gym;
  createdGymIds.push(gym.id);
  const memberRes = await api(tokens[ownerEmail], 'POST', `/gym/${gym.id}/members`,
    { first_name: 'Multi', email: PEOPLE.member.email });
  const memberRow0 = await memberRes.json();
  assert.strictEqual(memberRes.status, 201, `create member: ${JSON.stringify(memberRow0)}`);
  const link = await api(tokens[ownerEmail], 'POST',
    `/gym/${gym.id}/members/${memberRow0.id}/link-app`, { email: PEOPLE.member.email });
  const linkedRow = await link.json();
  assert.strictEqual(link.status, 200, `link-app: ${JSON.stringify(linkedRow)}`);
  return { gym, memberRow: linkedRow };
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

  // the member belongs to TWO gyms simultaneously (multi-gym core scenario)
  ({ gym: gymA, memberRow: memberRowA } =
    await setupGymWithMember(PEOPLE.ownerA.email, `LeaveTest Alpha ${suffix}`));
  ({ gym: gymB, memberRow: memberRowB } =
    await setupGymWithMember(PEOPLE.ownerB.email, `LeaveTest Beta ${suffix}`));
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── the multi-gym baseline ───────────────────────────────────────────────

test('user belongs to two gyms at once and sees both', async () => {
  const mine = await (await api(tokens[PEOPLE.member.email], 'GET', '/gym/my/memberships')).json();
  assert.strictEqual(mine.length, 2);
  assert.deepStrictEqual(mine.map((m) => m.gym_id).sort(), [gymA.id, gymB.id].sort());
  assert.ok(mine.every((m) => m.status === 'ACTIVE' && !m.left_at));
});

// ── leaving one gym ──────────────────────────────────────────────────────

test('leave: user leaves gym A — relationship becomes LEFT, history kept', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST',
    `/gym/my/memberships/${gymA.id}/leave`, {});
  const mine = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(mine));
  const leftRow = mine.find((m) => m.gym_id === gymA.id);
  assert.strictEqual(leftRow.status, 'LEFT');
  assert.ok(leftRow.left_at, 'left_at recorded');
  // gym B untouched
  assert.strictEqual(mine.find((m) => m.gym_id === gymB.id).status, 'ACTIVE');
});

test('leave: gym A resources now 403 with the precise former-member message', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'GET', `/gym/${gymA.id}/permissions`);
  assert.strictEqual(res.status, 403);
  const body = await res.json();
  assert.strictEqual(body.error, 'You are no longer an active member of this Gym');
});

test('leave: gym B continues to work normally (multi-gym isolation)', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'GET', `/gym/${gymB.id}/permissions`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).gymRole, 'MEMBER');
});

test('leave: idempotent — leaving an already-left gym is a no-op', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST',
    `/gym/my/memberships/${gymA.id}/leave`, {});
  assert.strictEqual(res.status, 200);
});

test('leave: never authorizes by client input', async () => {
  // unauthenticated
  assert.strictEqual((await api(null, 'POST', `/gym/my/memberships/${gymA.id}/leave`, {})).status, 401);
  // a gym the user has no relationship with
  const stranger = await signupAndLogin(`stranger_${suffix}@test.local`);
  const res = await api(stranger, 'POST', `/gym/my/memberships/${gymB.id}/leave`, {});
  assert.strictEqual(res.status, 404);
});

async function signupAndLogin(email) {
  const person = { email, name: 'Stranger' };
  const s = await signup(person);
  createdUserIds.push(s.user.id);
  return auth(person);
}

// ── admin archive + the member list ──────────────────────────────────────

test('admin archive: gym B owner archives the member → LEFT (REMOVED_BY_ADMIN)', async () => {
  const res = await api(tokens[PEOPLE.ownerB.email], 'POST',
    `/gym/${gymB.id}/members/${memberRowB.id}/archive`, { reason: 'moved away' });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.status, 'LEFT');
  assert.strictEqual(body.left_reason, 'REMOVED_BY_ADMIN');
  assert.ok(body.left_at);
});

test('archived member: out of the ACTIVE list, searchable via status=LEFT', async () => {
  const active = await (await api(tokens[PEOPLE.ownerB.email],
    'GET', `/gym/${gymB.id}/members?status=ACTIVE`)).json();
  assert.ok(!active.some((m) => m.id === memberRowB.id), 'LEFT member must not be in ACTIVE list');
  const left = await (await api(tokens[PEOPLE.ownerB.email],
    'GET', `/gym/${gymB.id}/members?status=LEFT`)).json();
  const row = left.find((m) => m.id === memberRowB.id);
  assert.ok(row, 'LEFT member is findable');
  assert.strictEqual(row.member_code, memberRowB.member_code, 'same member identity');
});

test('cross-gym: gym A owner cannot archive gym B members', async () => {
  // memberRowB belongs to gym B; gym A owner has no say over it
  const res = await api(tokens[PEOPLE.ownerA.email], 'POST',
    `/gym/${gymA.id}/members/${memberRowB.id}/archive`, {});
  assert.strictEqual(res.status, 404, "another gym's member id is a 404, never a leak");
});

test('PATCH cannot set status LEFT (lifecycle route only)', async () => {
  const res = await api(tokens[PEOPLE.ownerB.email], 'PATCH',
    `/gym/${gymB.id}/members/${memberRowB.id}`, { status: 'LEFT' });
  assert.strictEqual(res.status, 400);
});

// ── rejoin: SAME member row, history intact ──────────────────────────────

test('rejoin: reactivate restores the SAME gym_member identity (A: user-left)', async () => {
  const res = await api(tokens[PEOPLE.ownerA.email], 'POST',
    `/gym/${gymA.id}/members/${memberRowA.id}/reactivate`, {});
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.status, 'ACTIVE');
  assert.strictEqual(body.id, memberRowA.id, 'same member row');
  assert.strictEqual(body.member_code, memberRowA.member_code, 'same member code');
  assert.strictEqual(body.left_at, null, 'left_at cleared');
  // access restored through the same relationship
  const perms = await api(tokens[PEOPLE.member.email], 'GET', `/gym/${gymA.id}/permissions`);
  assert.strictEqual(perms.status, 200);
  assert.strictEqual((await perms.json()).gymRole, 'MEMBER');
});

test('rejoin: B owner reactivates their archived member too', async () => {
  const res = await api(tokens[PEOPLE.ownerB.email], 'POST',
    `/gym/${gymB.id}/members/${memberRowB.id}/reactivate`, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'ACTIVE');
});

test('rejoin: no duplicate member can be created for a LEFT member', async () => {
  // leave A again, then try to link the same user to a NEW member row
  await api(tokens[PEOPLE.member.email], 'POST', `/gym/my/memberships/${gymA.id}/leave`, {});
  // a LEFT member keeps their email claim — a second member row with the
  // same email is refused outright, so a duplicate identity can never be
  // created for a former member (spec: no duplicate member creation on rejoin)
  const fresh = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Dup', email: PEOPLE.member.email });
  assert.strictEqual(fresh.status, 409, JSON.stringify(await fresh.json()));
});

// ── audit trail ──────────────────────────────────────────────────────────

test('audit: leave / removed_by_admin / rejoined are recorded distinctly', async () => {
  const rows = await query(
    `SELECT action, entity_id FROM audit_logs
     WHERE gym_id = $1 AND entity = 'gym_member' AND action LIKE 'member.%'
     ORDER BY created_at`,
    [gymA.id]
  );
  const actions = rows.rows.map((r) => r.action);
  assert.ok(actions.includes('member.left_by_user'), `missing left_by_user: ${actions}`);
  assert.ok(actions.includes('member.rejoined'), `missing rejoined: ${actions}`);
  // gym B saw the admin path
  const rowsB = await query(
    `SELECT action FROM audit_logs WHERE gym_id = $1 AND action LIKE 'member.%' ORDER BY created_at`,
    [gymB.id]
  );
  const actionsB = rowsB.rows.map((r) => r.action);
  assert.ok(actionsB.includes('member.removed_by_admin'), `missing removed_by_admin: ${actionsB}`);
  assert.ok(actionsB.includes('member.rejoined'), `missing rejoined (B): ${actionsB}`);
});
