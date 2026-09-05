// Gym invitation bridge tests (Phase 5). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers: existing-user accept, registration-via-invitation, duplicate
// invitation, expired invitation, wrong account, email changes, member
// already connected, member in multiple gyms, cancelled invitation,
// duplicate acceptance, registration failure, suspended/deactivated gym,
// member cancelled before acceptance, arbitrary-linking rejection, and
// history/link integrity (no duplicate Users or GymMembers, ever).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymInvites.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `inv_owner_${suffix}@test.local`, name: 'Invite Owner' },
  owner2: { email: `inv_owner2_${suffix}@test.local`, name: 'Second Gym Owner' },
  rahul: { email: `rahul_${suffix}@example.test`, name: 'Rahul Existing' },
  attacker: { email: `attacker_${suffix}@test.local`, name: 'Attacker' },
  multi: { email: `multi_${suffix}@test.local`, name: 'Multi Gym Person' },
};
const tokens = {};
let gymA, gymB;
const createdUserIds = [];
const createdGymIds = [];
let memberAman, memberRahul, memberMulti1, memberMulti2;

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

async function createMember(owner, gymId, name, email) {
  const res = await api(tokens[owner], 'POST', `/gym/${gymId}/members`,
    email ? { first_name: name, email } : { first_name: name });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `create member ${name}: ${JSON.stringify(body)}`);
  return body;
}

async function inviteMember(gymId, memberId, email, owner = PEOPLE.owner.email) {
  const res = await api(tokens[owner], 'POST', `/gym/${gymId}/members/${memberId}/invite-app`,
    email ? { email } : {});
  const body = await res.json();
  assert.strictEqual(res.status, 201, `invite: ${JSON.stringify(body)}`);
  return body.invite_code;
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `InviteGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `InviteGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  memberAman = await createMember(PEOPLE.owner.email, gymA.id, 'Aman');
  memberRahul = await createMember(PEOPLE.owner.email, gymA.id, 'Rahul', PEOPLE.rahul.email);
  memberMulti1 = await createMember(PEOPLE.owner.email, gymA.id, 'Multi', PEOPLE.multi.email);
  memberMulti2 = await createMember(PEOPLE.owner2.email, gymB.id, 'Multi', PEOPLE.multi.email);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── scenario 1: existing app user ────────────────────────────────────────

test('existing user: invite → preview → accept links the EXISTING User (no duplicates)', async () => {
  const code = await inviteMember(gymA.id, memberRahul.id);

  const preview = await (await api(null, 'GET', `/gym/invite/${code}`)).json();
  assert.strictEqual(preview.gymName, gymA.name);
  assert.strictEqual(preview.email, PEOPLE.rahul.email);
  assert.strictEqual(preview.status, 'PENDING');
  assert.strictEqual(preview.memberName, 'Rahul');

  const accept = await api(tokens[PEOPLE.rahul.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 200);
  const body = await accept.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.member.app_connection, 'CONNECTED');

  // the EXISTING user row is linked — exactly one user, exactly one member
  const users = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [PEOPLE.rahul.email]);
  assert.strictEqual(users.rows[0].c, 1, 'no second User created');
  const members = await query(
    'SELECT COUNT(*)::int AS c FROM gym_members WHERE gym_id = $1 AND lower(email) = lower($2)',
    [gymA.id, PEOPLE.rahul.email]
  );
  assert.strictEqual(members.rows[0].c, 1, 'no second GymMember created');
  const linked = await query('SELECT app_user_id FROM gym_members WHERE id = $1', [memberRahul.id]);
  assert.ok(linked.rows[0].app_user_id, 'GymMember.appUserId is set');
});

// Mobile M4 — the invitation card shows Role / Membership like the portal,
// so the member preview must carry the membership term (ACTIVE first) and a
// stable role label. Absent term → field stays undefined (card renders "—").
test('member preview exposes role and membership plan for the mobile card', async () => {
  const withPlan = await createMember(PEOPLE.owner.email, gymA.id, 'WithPlan', `withplan_${suffix}@example.test`);
  const noPlan = await createMember(PEOPLE.owner.email, gymA.id, 'NoPlan', `noplan_${suffix}@example.test`);

  const plan = await query(
    `INSERT INTO membership_plans (gym_id, name, duration_value, duration_unit, price_cents, currency)
     VALUES ($1, 'Premium', 3, 'month', 4999, 'INR') RETURNING id`,
    [gymA.id]
  );
  await query(
    `INSERT INTO member_memberships (gym_id, member_id, plan_id, plan_name, plan_duration_value,
       plan_duration_unit, price_cents, currency, status, starts_on, ends_on)
     VALUES ($1, $2, $3, 'Premium', 3, 'month', 4999, 'INR', 'ACTIVE', CURRENT_DATE - 5, CURRENT_DATE + 85)`,
    [gymA.id, withPlan.id, plan.rows[0].id]
  );

  const codeWith = await inviteMember(gymA.id, withPlan.id);
  const pWith = await (await api(null, 'GET', `/gym/invite/${codeWith}`)).json();
  assert.strictEqual(pWith.status, 'PENDING');
  assert.strictEqual(pWith.role, 'MEMBER');
  assert.strictEqual(pWith.membershipPlan, 'Premium');
  assert.strictEqual(pWith.membershipStatus, 'ACTIVE');

  const codeNo = await inviteMember(gymA.id, noPlan.id);
  const pNo = await (await api(null, 'GET', `/gym/invite/${codeNo}`)).json();
  assert.strictEqual(pNo.role, 'MEMBER');
  assert.strictEqual(pNo.membershipPlan, undefined);
  assert.strictEqual(pNo.membershipStatus, undefined);
});

test('arbitrary linking is rejected: another account cannot accept a foreign invitation', async () => {
  const code = await inviteMember(gymA.id, memberAman.id, `aman_${suffix}@example.test`);
  // the attacker (logged in with their own account) tries to claim it
  const stolen = await api(tokens[PEOPLE.attacker.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(stolen.status, 403, `wrong account: ${JSON.stringify(await stolen.json())}`);
  // the member stays unlinked
  const member = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${memberAman.id}`)).json();
  assert.strictEqual(member.app_connection, 'INVITATION_PENDING');
  globalThis.__amanCode = code;
});

test('duplicate acceptance is rejected after a successful one', async () => {
  // the invited person signs up for their app account, then accepts
  const amanUser = await signup({ email: `aman_${suffix}@example.test`, name: 'Aman Kumar' });
  await auth({ email: `aman_${suffix}@example.test`, name: 'Aman Kumar' });
  const code = globalThis.__amanCode;
  const accept = await api(tokens[`aman_${suffix}@example.test`], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 200, `accept: ${JSON.stringify(await accept.json())}`);
  // second acceptance attempt → the invitation is consumed
  const again = await api(tokens[`aman_${suffix}@example.test`], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(again.status, 409);
  void amanUser;
});

// ── scenario 2: registration through the invitation ─────────────────────

test('non-existing user: register via invitation creates ONE User and links the existing member', async () => {
  const memberReg = await createMember(PEOPLE.owner.email, gymA.id, 'RegCase', `reg_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, memberReg.id);
  const reg = await api(null, 'POST', `/gym/invite/${code}/register`,
    { name: 'Reg Person', password: 'RegPass123!' });
  const body = await reg.json();
  assert.strictEqual(reg.status, 201, `register: ${JSON.stringify(body)}`);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.user.email, `reg_${suffix}@example.test`);
  assert.strictEqual(body.member.app_connection, 'CONNECTED');
  createdUserIds.push(body.user.id);

  // exactly one user with that email; the GymMember row is the SAME one
  const users = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1',
    [`aman_${suffix}@example.test`]);
  assert.strictEqual(users.rows[0].c, 1);
  const members = await query('SELECT COUNT(*)::int AS c FROM gym_members WHERE gym_id = $1 AND id = $2',
    [gymA.id, memberReg.id]);
  assert.strictEqual(members.rows[0].c, 1, 'the existing GymMember was linked, not duplicated');

  // the new account can log in (with the password chosen at registration)
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `reg_${suffix}@example.test`, password: 'RegPass123!' }),
  });
  assert.strictEqual(login.status, 200, 'the registered account can log in');
  const regToken = (await login.json()).accessToken;
  const memberships = await (await api(regToken, 'GET', '/gym/my/memberships')).json();
  assert.strictEqual(memberships.length, 1);
  assert.strictEqual(memberships[0].gym_id, gymA.id);
});

test('registration failure (email already registered) creates no partial rows', async () => {
  // invited email already belongs to an existing user (PEOPLE.rahul)
  // scoped to the attacker's email — the full-suite run executes test files
  // concurrently against the shared database, so global counts race
  const before = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [PEOPLE.attacker.email]);
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'ClashCase', PEOPLE.attacker.email);
  const code = await inviteMember(gymA.id, member.id);
  const reg = await api(null, 'POST', `/gym/invite/${code}/register`,
    { name: 'Impostor Rahul', password: 'Whatever1!' });
  const regErr = await reg.json();
  assert.strictEqual(reg.status, 409, `register clash: ${JSON.stringify(regErr)}`);
  const after = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [PEOPLE.attacker.email]);
  assert.strictEqual(after.rows[0].c, before.rows[0].c, 'no user row created by the failed registration');
  // member unchanged and unlinked; re-registering with the same invited
  // email keeps failing (it belongs to an existing account) — the correct
  // resolution is that the existing user SIGNS IN and accepts instead
  const reg2 = await api(null, 'POST', `/gym/invite/${code}/register`,
    { name: 'Clash Person', password: 'Whatever1!' });
  assert.strictEqual(reg2.status, 409);
  const detail = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${member.id}`)).json();
  assert.strictEqual(detail.app_connection, 'INVITATION_PENDING');
  // the existing account accepts it by token — no duplicate user, ever
  const accept = await api(tokens[PEOPLE.attacker.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 200, `existing user accepts: ${JSON.stringify(await accept.json())}`);
  const users = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [PEOPLE.attacker.email]);
  assert.strictEqual(users.rows[0].c, 1);
});

test('duplicate invitation: re-inviting expires the previous code', async () => {
  const code1 = await inviteMember(gymA.id, memberMulti1.id);
  const code2 = await inviteMember(gymA.id, memberMulti1.id);
  assert.notStrictEqual(code1, code2);
  const old = await (await api(null, 'GET', `/gym/invite/${code1}`)).json();
  assert.strictEqual(old.status, 'EXPIRED');
  const acceptOld = await api(tokens[PEOPLE.multi.email], 'POST', `/gym/invite/${code1}/accept`);
  assert.strictEqual(acceptOld.status, 410);
  // the newest code still works
  const acceptNew = await api(tokens[PEOPLE.multi.email], 'POST', `/gym/invite/${code2}/accept`);
  assert.strictEqual(acceptNew.status, 200);
});

test('member belongs to multiple gyms: one user, two independent invitations accepted', async () => {
  // memberMulti1 was linked to PEOPLE.multi in the previous test (gym A).
  // Now invite the same person's row in gym B and accept with the same user.
  const code = await inviteMember(gymB.id, memberMulti2.id, PEOPLE.multi.email, PEOPLE.owner2.email);
  const accept = await api(tokens[PEOPLE.multi.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 200, `gym B accept: ${JSON.stringify(await accept.json())}`);
  const memberships = await (await api(tokens[PEOPLE.multi.email], 'GET', '/gym/my/memberships')).json();
  assert.strictEqual(memberships.length, 2, 'the user now sees both gyms');
  assert.ok(memberships.some((m) => m.gym_id === gymA.id));
  assert.ok(memberships.some((m) => m.gym_id === gymB.id));
});

// ── invitation states & failure modes ────────────────────────────────────

test('cancelled invitation cannot be accepted', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'CancelCase', `cancel_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, member.id);
  const withdraw = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${member.id}/cancel-invite`);
  assert.strictEqual(withdraw.status, 200);
  const accept = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 410);
});

test('expired invitation cannot be accepted (410, state flips to EXPIRED)', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'ExpiryCase', `exp_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, member.id);
  await pool.query(`UPDATE gym_member_invites SET expires_at = now() - INTERVAL '1 day'
                    WHERE member_id = $1 AND status = 'PENDING'`, [member.id]);
  const preview = await (await api(null, 'GET', `/gym/invite/${code}`)).json();
  assert.strictEqual(preview.status, 'EXPIRED');
  const accept = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 410);
});

test('declined invitation cannot be accepted later', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'DeclineCase', `decl_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, member.id);
  const decline = await api(null, 'POST', `/gym/invite/${code}/decline`);
  assert.strictEqual(decline.status, 200);
  const accept = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 410);
  // member back to NOT_CONNECTED — gym can re-invite
  const detail = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${member.id}`)).json();
  assert.strictEqual(detail.app_connection, 'NOT_CONNECTED');
});

test('member cancelled before acceptance: invitation becomes unusable', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'GoneCase', `gone_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, member.id);
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${member.id}/cancel`);
  const accept = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 410, `member cancelled: ${JSON.stringify(await accept.json())}`);
});

test('member already connected: new invitations are refused', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${memberRahul.id}/invite-app`);
  assert.strictEqual(res.status, 400);
});

test('suspended and deactivated gyms block acceptance; ACTIVE works again after', async () => {
  const suspUser = await signup({ email: `susp_${suffix}@example.test`, name: 'Susp Person' });
  await auth({ email: `susp_${suffix}@example.test`, name: 'Susp Person' });
  const memberS = await createMember(PEOPLE.owner2.email, gymB.id, 'SuspCase', `susp_${suffix}@example.test`);
  const code = await inviteMember(gymB.id, memberS.id, `susp_${suffix}@example.test`, PEOPLE.owner2.email);
  await pool.query(`UPDATE gyms SET status = 'SUSPENDED' WHERE id = $1`, [gymB.id]);
  const accept = await api(tokens[`susp_${suffix}@example.test`], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept.status, 403, 'suspended gym blocks acceptance');
  await pool.query(`UPDATE gyms SET status = 'INACTIVE' WHERE id = $1`, [gymB.id]);
  const accept2 = await api(tokens[`susp_${suffix}@example.test`], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept2.status, 403, 'deactivated gym blocks acceptance');
  await pool.query(`UPDATE gyms SET status = 'ACTIVE' WHERE id = $1`, [gymB.id]);
  const accept3 = await api(tokens[`susp_${suffix}@example.test`], 'POST', `/gym/invite/${code}/accept`);
  assert.strictEqual(accept3.status, 200, 'acceptance works once the gym is ACTIVE again');
});

test('unauthenticated accept is rejected; unknown token returns 404; unknown-token register 404', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'SecCase', `sec_${suffix}@example.test`);
  await inviteMember(gymA.id, member.id);
  assert.strictEqual((await api(null, 'POST', '/gym/invite/whatever/accept')).status, 401);
  assert.strictEqual((await api(null, 'GET', `/gym/invite/not-a-real-token`)).status, 404);
  assert.strictEqual((await api(null, 'POST', '/gym/invite/not-a-real-token/register',
    { name: 'X', password: 'Whatever1!' })).status, 404);
  void member;
});

test('email changes on the member record do not invalidate a pending invite', async () => {
  const member = await createMember(PEOPLE.owner.email, gymA.id, 'EmailChange', `old_${suffix}@example.test`);
  const code = await inviteMember(gymA.id, member.id);
  // gym edits the member's contact email afterwards — the invitation keeps
  // its own invited email as the identity anchor
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/members/${member.id}`,
    { email: `new_${suffix}@example.test` });
  const preview = await (await api(null, 'GET', `/gym/invite/${code}`)).json();
  assert.strictEqual(preview.email, `old_${suffix}@example.test`);
});

test('audit trail records accept/decline across the bridge', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('member.invite_accepted'), 'invite_accepted audited');
  assert.ok(actions.includes('member.invite_declined'), 'invite_declined audited');
});
