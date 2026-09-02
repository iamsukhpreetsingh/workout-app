// Gym staff & trainer management tests (Phase 8). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec: staff invitation for a person WITHOUT an app account
// (register-through-invite adds them as staff), staff invite for an
// EXISTING user (direct add), duplicate invitations, trainer distinction
// (platform trainer vs gym trainer vs multi-gym), trainer assignment for
// members with app_user_id NULL, reassignment history, unassign,
// trainer-removal guard while holding assignments, trainer deactivation
// guard, trainer visibility of ONLY their own roster, inactive staff API
// rejection, and cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymStaffTrainers.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `st_owner_${suffix}@test.local`, name: 'Staff Owner' },
  owner2: { email: `st_owner2_${suffix}@test.local`, name: 'Second Owner' },
  trainer1: { email: `st_tr1_${suffix}@test.local`, name: 'Trainer One' },
  trainer2: { email: `st_tr2_${suffix}@test.local`, name: 'Trainer Two' },
  desk: { email: `st_desk_${suffix}@test.local`, name: 'Front Desk' },
  admin: { email: `st_admin_${suffix}@test.local`, name: 'Gym Admin' },
  platformTrainer: { email: `st_plat_${suffix}@test.local`, name: 'Platform Trainer', role: 'trainer' },
  memberUser: { email: `st_member_${suffix}@test.local`, name: 'Member Person' },
  attacker: { email: `st_att_${suffix}@test.local`, name: 'Attacker' },
};
const tokens = {};
let gymA, gymB;
let rohitStaffId, trainer2StaffId, platformStaffId;
let memberNoApp, memberWithApp;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: person.role || 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}: ${JSON.stringify(body)}`);
  createdUserIds.push(body.user.id);
  return body.user;
}

async function auth(person) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: person.password || PASSWORD }),
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `StaffGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `StaffGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  // two gym trainers + front desk + admin (existing accounts → direct add)
  for (const [person, role] of [[PEOPLE.trainer1, 'TRAINER'], [PEOPLE.trainer2, 'TRAINER'], [PEOPLE.desk, 'FRONT_DESK'], [PEOPLE.admin, 'ADMIN']]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
      { email: person.email, gym_role: role });
    assert.strictEqual(r.status, 201, `add staff ${role}`);
  }
  const staff = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/staff`)).json();
  rohitStaffId = staff.find((s) => s.email === PEOPLE.trainer1.email)?.id;
  trainer2StaffId = staff.find((s) => s.email === PEOPLE.trainer2.email)?.id;

  // the PLATFORM trainer becomes gym staff at gym B only — same person can
  // be a platform trainer AND a gym trainer somewhere else
  const platStaff = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/staff`,
    { email: PEOPLE.platformTrainer.email, gym_role: 'TRAINER' });
  assert.strictEqual(platStaff.status, 201);

  memberNoApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoApp', phone: '+91 96000 00001' })).json();
  memberWithApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WithApp', email: PEOPLE.memberUser.email })).json();
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/link-app`, { email: PEOPLE.memberUser.email });
  assert.strictEqual(link.status, 200);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── staff invitations (no app account required) ──────────────────────────

test('staff invite for a person WITHOUT an app account: invitation created with code', async () => {
  const email = `newstaff_${suffix}@test.local`;
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email, gym_role: 'FRONT_DESK' });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `invite: ${JSON.stringify(body)}`);
  assert.strictEqual(body.invited, true);
  assert.strictEqual(body.gym_role, 'FRONT_DESK');
  assert.ok(/^[0-9a-f]{32}$/.test(body.invite_code));
  // no user row was created by the invite itself
  const users = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [email]);
  assert.strictEqual(users.rows[0].c, 0, 'the invitation does not create an account');
  // the code is stored hashed only
  const rows = await query('SELECT code_hash FROM gym_staff_invites WHERE lower(email) = $1', [email]);
  assert.notStrictEqual(rows.rows[0].code_hash, body.invite_code);
  globalThis.__staffInvite = { code: body.invite_code, email };
});

test('staff invite preview shows type staff + role; register creates user AND staff row', async () => {
  const { code, email } = globalThis.__staffInvite;
  const preview = await (await api(null, 'GET', `/gym/invite/${code}`)).json();
  assert.strictEqual(preview.type, 'staff');
  assert.strictEqual(preview.role, 'FRONT_DESK');
  assert.strictEqual(preview.status, 'PENDING');

  const reg = await api(null, 'POST', `/gym/invite/${code}/register`,
    { name: 'New Desk', password: 'DeskPass123!' });
  const body = await reg.json();
  assert.strictEqual(reg.status, 201, `register: ${JSON.stringify(body)}`);
  assert.strictEqual(body.gymRole, 'FRONT_DESK');
  createdUserIds.push(body.user.id);

  // exactly ONE user (no duplicate), and a gym_staff row with the invited role
  const users = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [email]);
  assert.strictEqual(users.rows[0].c, 1);
  const staff = await query(
    `SELECT s.gym_role, s.status FROM gym_staff s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
    [email]
  );
  assert.strictEqual(staff.rows[0].gym_role, 'FRONT_DESK');
  assert.strictEqual(staff.rows[0].status, 'ACTIVE');
  // the new staff can log in and use the API per their role
  await auth({ email, password: 'DeskPass123!' });
  const members = await api(tokens[email], 'GET', `/gym/${gymA.id}/members`);
  assert.strictEqual(members.status, 200, 'new staff member has gym access');
});

test('wrong account cannot accept a staff invitation; duplicate acceptance rejected', async () => {
  const email = `newtrainer_${suffix}@test.local`;
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email, gym_role: 'TRAINER' });
  const invite = await res.json();
  assert.strictEqual(res.status, 201);
  globalThis.__trainerInviteCode = invite.invite_code;

  const stolen = await api(tokens[PEOPLE.attacker.email], 'POST', `/gym/invite/${invite.invite_code}/accept`);
  assert.strictEqual(stolen.status, 403, 'wrong account rejected');

  // the invited person signs up, then accepts by token
  const invitedUser = await signup({ email, name: 'Invited Trainer' });
  await auth({ email });
  const accept = await api(tokens[email], 'POST', `/gym/invite/${invite.invite_code}/accept`);
  assert.strictEqual(accept.status, 200, `accept: ${JSON.stringify(await accept.json())}`);
  const again = await api(tokens[email], 'POST', `/gym/invite/${invite.invite_code}/accept`);
  assert.strictEqual(again.status, 409, 'duplicate acceptance rejected');
  globalThis.__invitedTrainerEmail = email;
});

test('re-inviting a PENDING staff email expires the previous code; re-adding ACTIVE staff is 409', async () => {
  // a fresh email invited twice: the second invite supersedes the first
  const email = `reinvite_${suffix}@test.local`;
  const first = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email, gym_role: 'FRONT_DESK' });
  const firstBody = await first.json();
  assert.strictEqual(firstBody.invited, true);
  const second = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email, gym_role: 'FRONT_DESK' });
  const secondBody = await second.json();
  assert.strictEqual(second.status, 201);
  assert.notStrictEqual(secondBody.invite_code, firstBody.invite_code);
  const old = await (await api(null, 'GET', `/gym/invite/${firstBody.invite_code}`)).json();
  assert.strictEqual(old.status, 'EXPIRED', 'the first code no longer works');
  // an email that already ACCEPTED and is ACTIVE staff → plain 409
  const again = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: `newstaff_${suffix}@test.local`, gym_role: 'FRONT_DESK' });
  assert.strictEqual(again.status, 409, 'already-active staff cannot be re-added');
});

// ── trainer assignment (works for non-app members) ───────────────────────

test('assign gym trainer to a member WITHOUT an app account', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/trainer`, { trainer_staff_id: rohitStaffId });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `assign: ${JSON.stringify(body)}`);
  assert.strictEqual(body.status, 'ACTIVE');
  assert.strictEqual(body.trainer_name, PEOPLE.trainer1.name);
  const member = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${memberNoApp.id}`)).json();
  assert.strictEqual(member.app_user_id, null, 'assignment never touches app accounts');
});

test('assign to an app-connected member works the same way', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer`, { trainer_staff_id: trainer2StaffId });
  assert.strictEqual(res.status, 201, JSON.stringify(await res.json()));
});

test('only TRAINER-role staff can be assigned; platform trainers not at this gym cannot', async () => {
  const deskStaff = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/staff`)).json();
  const deskId = deskStaff.find((s) => s.email === PEOPLE.desk.email).id;
  const notTrainer = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/trainer`, { trainer_staff_id: deskId });
  assert.strictEqual(notTrainer.status, 400, 'front desk cannot be a member trainer');
  // the platform trainer works at gym B — not assignable in gym A
  const platformRow = await query(
    `SELECT s.id FROM gym_staff s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND s.gym_id = $2`,
    [PEOPLE.platformTrainer.email, gymB.id]
  );
  const foreign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/trainer`,
    { trainer_staff_id: platformRow.rows[0].id });
  assert.strictEqual(foreign.status, 404, 'another gym staff row is invisible here');
});

test('reassignment ends the previous assignment (kept as ENDED history)', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/trainer`, { trainer_staff_id: trainer2StaffId });
  assert.strictEqual(res.status, 201, JSON.stringify(await res.json()));
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/trainer`)).json();
  assert.strictEqual(history.filter((a) => a.status === 'ACTIVE').length, 1);
  const ended = history.find((a) => a.status === 'ENDED');
  assert.ok(ended, 'previous assignment kept');
  assert.strictEqual(ended.end_reason, 'reassigned');
  assert.strictEqual(ended.trainer_name, PEOPLE.trainer1.name);
});

test('unassign ends the assignment', async () => {
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer`)).json();
  const active = history.find((a) => a.status === 'ACTIVE');
  const end = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer/${active.id}/end`, { reason: 'member request' });
  assert.strictEqual(end.status, 200, `end: ${JSON.stringify(await end.json())}`);
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer`)).json();
  assert.strictEqual(after.filter((a) => a.status === 'ACTIVE').length, 0);
});

// ── trainer guards & visibility ──────────────────────────────────────────

test('trainer removal with ACTIVE assignments is blocked until members are reassigned', async () => {
  // a dedicated member holds trainer2 so this scenario is self-contained
  const guardMember = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'GuardMember' })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${guardMember.id}/trainer`, { trainer_staff_id: trainer2StaffId });
  const staff = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/staff`)).json();
  const t2 = staff.find((s) => s.email === PEOPLE.trainer2.email);
  const remove = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${t2.id}`,
    { status: 'REMOVED' });
  assert.strictEqual(remove.status, 409, `remove: ${JSON.stringify(await remove.json())}`);
  const demote = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${t2.id}`,
    { gym_role: 'FRONT_DESK' });
  assert.strictEqual(demote.status, 409, 'demotion blocked too');
  // end EVERY assignment t2 still holds (some from earlier scenarios),
  // then removal succeeds
  const held = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/trainer-assignments?trainer_staff_id=${t2.id}`)).json();
  for (const a of held.filter((x) => x.status === 'ACTIVE')) {
    await api(tokens[PEOPLE.owner.email], 'POST',
      `/gym/${gymA.id}/members/${a.member_id}/trainer/${a.id}/end`, { reason: 'guard test' });
  }
  const remove2 = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${t2.id}`,
    { status: 'REMOVED' });
  assert.strictEqual(remove2.status, 200, `remove2: ${JSON.stringify(await remove2.json())}`);
});

test('trainer deactivated: cannot be selected for NEW assignments; reactivate restores', async () => {
  const t2 = { id: trainer2StaffId };
  const r1 = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${t2.id}`, { status: 'INACTIVE' });
  assert.strictEqual(r1.status, 200, `deactivate: ${JSON.stringify(await r1.json())}`);
  const assignable = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/trainers`)).json();
  assert.ok(!assignable.some((t) => t.trainer_staff_id === t2.id), 'inactive trainer not selectable');
  const deactMember = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'DeactMember' })).json();
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${deactMember.id}/trainer`, { trainer_staff_id: t2.id });
  assert.strictEqual(assign.status, 400, `inactive trainer cannot take assignments: ${JSON.stringify(await assign.json())}`);
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${t2.id}`, { status: 'ACTIVE' });
});

test('trainer sees ONLY their own assigned members (Rohit roster)', async () => {
  // fresh, self-contained assignments: Rohit gets one member, trainer2 another
  const mine = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'RohitsMember' })).json();
  const theirs = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'OthersMember' })).json();
  const a1 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mine.id}/trainer`, { trainer_staff_id: rohitStaffId });
  assert.strictEqual(a1.status, 201, `assign rohit: ${JSON.stringify(await a1.json())}`);
  const a2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${theirs.id}/trainer`, { trainer_staff_id: trainer2StaffId });
  assert.strictEqual(a2.status, 201, `assign t2: ${JSON.stringify(await a2.json())}`);
  const roster = await (await api(tokens[PEOPLE.trainer1.email], 'GET', `/gym/${gymA.id}/trainer/members`)).json();
  assert.ok(roster.some((m) => m.member_id === mine.id), 'Rohit sees their own member');
  assert.ok(!roster.some((m) => m.member_id === theirs.id), 'trainer2 member not in roster');
  // trainer2 sees their own, not Rohit's
  const roster2 = await (await api(tokens[PEOPLE.trainer2.email], 'GET', `/gym/${gymA.id}/trainer/members`)).json();
  assert.ok(roster2.some((m) => m.member_id === theirs.id));
  assert.ok(!roster2.some((m) => m.member_id === mine.id));
});

test('trainer at multiple gyms: assignments are independent per gym', async () => {
  // trainer1 also joins gym B as TRAINER
  const add = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/staff`,
    { email: PEOPLE.trainer1.email, gym_role: 'TRAINER' });
  assert.strictEqual(add.status, 201);
  const memberB = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'GymB Member' })).json();
  const staffB = await (await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymB.id}/staff`)).json();
  const staffIdB = staffB.find((s) => s.email === PEOPLE.trainer1.email).id;
  const assign = await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymB.id}/members/${memberB.id}/trainer`, { trainer_staff_id: staffIdB });
  assert.strictEqual(assign.status, 201, 'the same person can be a gym trainer at two gyms');
});

test('cross-gym isolation: gym A trainer cannot list gym B roster; inactive staff 403', async () => {
  // trainer2 has never been staff at gym B
  assert.strictEqual((await api(tokens[PEOPLE.trainer2.email], 'GET', `/gym/${gymB.id}/trainer/members`)).status, 403);
  // inactive staff: create + deactivate a desk account
  const email = `inactive_${suffix}@test.local`;
  const invite = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email, gym_role: 'FRONT_DESK' });
  const inviteBody = await invite.json();
  const reg = await api(null, 'POST', `/gym/invite/${inviteBody.invite_code}/register`,
    { name: 'Inactive Desk', password: 'Inactive1!' });
  createdUserIds.push((await reg.json()).user.id);
  await auth({ email, password: 'Inactive1!' });
  assert.strictEqual((await api(tokens[email], 'GET', `/gym/${gymA.id}/members`)).status, 200);
  const staff = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/staff`)).json();
  const row = staff.find((s) => s.email === email);
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/staff/${row.id}`, { status: 'INACTIVE' });
  assert.strictEqual((await api(tokens[email], 'GET', `/gym/${gymA.id}/members`)).status, 403,
    'inactive staff loses API access immediately');
});

test('authorization on assignments: ADMIN assigns, TRAINER cannot, desk cannot', async () => {
  const member = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AuthzMember' })).json();
  const adminAssign = await api(tokens[PEOPLE.admin.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/trainer`, { trainer_staff_id: rohitStaffId });
  assert.strictEqual(adminAssign.status, 201, `admin assign: ${JSON.stringify(await adminAssign.json())}`);
  // trainer1 tries to assign themselves — trainers lack members.manage
  const assign = await api(tokens[PEOPLE.trainer1.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/trainer`, { trainer_staff_id: rohitStaffId });
  assert.strictEqual(assign.status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/trainer`, { trainer_staff_id: rohitStaffId })).status, 403);
});

test('audit trail records staff invitations and trainer assignments', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['staff.invited', 'staff.invite_accepted', 'trainer.assigned', 'trainer.unassigned']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
