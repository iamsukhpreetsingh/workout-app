// Active-trainer resolution tests (Profile + My Gym consistency).
// Real routers, real DATABASE_URL, self-cleaning fixtures — mirrors the
// gymStaffTrainers.test.js harness.
//
// Covers the spec's testing matrix: gym-assigned > user-connected > none;
// removal falls back to the preserved user relationship; reassignment
// follows the gym; invite codes are blocked (and NEVER burned) while a gym
// trainer exists; cancel leaves the gym → independent trainer surfaces
// again; preview surfaces the gym trainer; auth gates.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('trainerActive.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');
const clientRoutes = require('../src/routes/client');
const trainerClients = require('../src/data/trainerClients');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'ActiveTrainer1!';

const PEOPLE = {
  owner: { email: `at_owner_${suffix}@test.local`, name: 'Gym Owner' },
  gymTrainer1: { email: `at_gt1_${suffix}@test.local`, name: 'Gym Trainer One' },
  gymTrainer2: { email: `at_gt2_${suffix}@test.local`, name: 'Gym Trainer Two' },
  platformTrainer: { email: `at_pt_${suffix}@test.local`, name: 'Platform Trainer', role: 'trainer' },
  member: { email: `at_member_${suffix}@test.local`, name: 'Member Person' },
};
const tokens = {};
let gym, trainer1StaffId, trainer2StaffId, memberId, memberUserId, platformTrainerId, gym2Id, gym2MemberId;
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

const getActive = async () => (await api(tokens[PEOPLE.member.email], 'GET', '/client/trainer/active')).json();

let inviteCode = null; // reused across the blocked → redeemed sequence

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  app.use('/client', clientRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  const resG = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `ActiveTrainerGym ${suffix}` });
  gym = (await resG.json()).gym;
  createdGymIds.push(gym.id);

  for (const person of [PEOPLE.gymTrainer1, PEOPLE.gymTrainer2]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gym.id}/staff`,
      { email: person.email, gym_role: 'TRAINER' });
    assert.strictEqual(r.status, 201, `add staff ${person.email}`);
  }
  const staff = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gym.id}/staff`)).json();
  trainer1StaffId = staff.find((s) => s.email === PEOPLE.gymTrainer1.email)?.id;
  trainer2StaffId = staff.find((s) => s.email === PEOPLE.gymTrainer2.email)?.id;

  // app-linked member
  const mem = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gym.id}/members`,
    { first_name: 'Member', email: PEOPLE.member.email })).json();
  memberId = mem.id;
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/link-app`, { email: PEOPLE.member.email });
  assert.strictEqual(link.status, 200);

  const memberRow = await query('SELECT id FROM users WHERE email = $1', [PEOPLE.member.email]);
  memberUserId = memberRow.rows[0].id;
  const ptRow = await query('SELECT id FROM users WHERE email = $1', [PEOPLE.platformTrainer.email]);
  platformTrainerId = ptRow.rows[0].id;

  // a single-use platform invite code, valid for the whole run
  inviteCode = `AT${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
  await trainerClients.createInviteCode(platformTrainerId, inviteCode,
    new Date(Date.now() + 3600_000));
});

test.after(async () => {
  // relationship rows reference users — clear them before user deletion
  await pool.query(
    'DELETE FROM trainer_clients WHERE trainer_id = ANY($1::uuid[]) OR client_id = ANY($1::uuid[])',
    [createdUserIds]);
  await pool.query(
    'DELETE FROM trainer_invite_codes WHERE trainer_id = ANY($1::uuid[])',
    [createdUserIds]);
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  // fetch() (undici) keep-alive sockets hold the process open otherwise
  server.closeAllConnections?.();
  await pool.end();
});

test('auth gate: /client/trainer/active requires a token', async () => {
  const res = await api(null, 'GET', '/client/trainer/active');
  assert.strictEqual(res.status, 401);
});

test('matrix 1 — no gym trainer, no connected trainer → resolved null', async () => {
  const body = await getActive();
  assert.strictEqual(body.source, null);
  assert.strictEqual(body.trainer, null);
  assert.strictEqual(body.user_trainer, null);
});

test('matrix 11 — invalid invite code → 400, nothing created', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/associations/request',
    { invite_code: 'NOSUCHCODE12' });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /Invalid or expired invite code/);
  const state = await getActive();
  assert.strictEqual(state.trainer, null);
});

test('matrix 2 — gym assigns a trainer → active trainer = GYM source', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer1StaffId });
  assert.strictEqual(res.status, 201);

  const body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.status, 'active');
  assert.strictEqual(body.trainer.name, PEOPLE.gymTrainer1.name);
  assert.strictEqual(body.gym.name, gym.name);
  assert.strictEqual(body.user_trainer, null);
});

test('matrix 10 — invite code while gym trainer exists → 409 naming trainer+gym, code NOT burned', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/associations/request',
    { invite_code: inviteCode });
  assert.strictEqual(res.status, 409);
  const msg = (await res.json()).error;
  assert.match(msg, /already assigned you a trainer/);
  assert.ok(msg.includes(PEOPLE.gymTrainer1.name), 'message names the assigned trainer');
  assert.ok(msg.includes(gym.name), 'message names the gym');
  // the single-use code survives the blocked redemption
  const still = await query(
    'SELECT used_at FROM trainer_invite_codes WHERE code = $1', [inviteCode]);
  assert.strictEqual(still.rows[0].used_at, null);
});

test('preview surfaces the gym trainer while the assignment exists', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'GET',
    `/client/trainer-code-preview?code=${encodeURIComponent(inviteCode)}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.gym_trainer.trainer_name, PEOPLE.gymTrainer1.name);
  assert.strictEqual(body.gym_trainer.gym_name, gym.name);
});

test('matrix 5 — gym assignment removed, no independent trainer → resolved null', async () => {
  const assignment = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gym.id}/members/${memberId}/trainer`)).json();
  const activeId = assignment.find((a) => a.status === 'ACTIVE')?.id;
  const end = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer/${activeId}/end`, { reason: 'reassigned_test' });
  assert.strictEqual(end.status, 200);

  const body = await getActive();
  assert.strictEqual(body.source, null);
  assert.strictEqual(body.trainer, null);
});

test('matrix 12 — invite code succeeds once no gym trainer exists → pending USER trainer', async () => {
  // the SAME code from the blocked attempt — proves it was never burned
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/associations/request',
    { invite_code: inviteCode });
  assert.strictEqual(res.status, 201, `redeem: ${JSON.stringify(await res.text())}`);

  const body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.status, 'pending');
  assert.strictEqual(body.trainer.name, PEOPLE.platformTrainer.name);
});

test('connected trainer activates after the trainer accepts → USER active', async () => {
  const rel = await query(
    `SELECT id FROM trainer_clients WHERE client_id = $1 AND status = 'pending'`,
    [memberUserId]);
  // data-layer accept — the acceptance ROUTE is trainer-router surface, not
  // what this suite exercises; the resolution only reads the resulting row
  const row = await trainerClients.respondToAssociation(
    platformTrainerId, rel.rows[0].id, 'accept', null);
  assert.strictEqual(row.status, 'active');

  const body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.status, 'active');
  assert.strictEqual(body.trainer.name, PEOPLE.platformTrainer.name);
});

test('matrix 4 — gym assigns while a USER trainer is connected → GYM wins, USER relationship preserved', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer1StaffId });
  assert.strictEqual(res.status, 201);

  const body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.trainer.name, PEOPLE.gymTrainer1.name);
  assert.strictEqual(body.user_trainer.name, PEOPLE.platformTrainer.name);
  assert.strictEqual(body.user_trainer.status, 'active');
});

test('matrix 7 — gym reassigns to another trainer → active follows the gym (no stale cache server-side)', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer2StaffId });
  assert.strictEqual(res.status, 201);

  const body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.trainer.name, PEOPLE.gymTrainer2.name);
  assert.strictEqual(body.gym.name, gym.name);
});

test('matrix 6 — gym trainer removed → automatic fallback to the preserved USER trainer', async () => {
  const assignment = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gym.id}/members/${memberId}/trainer`)).json();
  const activeId = assignment.find((a) => a.status === 'ACTIVE')?.id;
  const end = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer/${activeId}/end`, { reason: 'left' });
  assert.strictEqual(end.status, 200);

  const body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.status, 'active');
  assert.strictEqual(body.trainer.name, PEOPLE.platformTrainer.name,
    'the invite-connected trainer surfaces again — no broken state');
});

test('matrix 9 — member leaves the gym → gym assignment no longer active, independent trainer stands', async () => {
  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/cancel`, {});
  assert.strictEqual(cancel.status, 200);

  const body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.trainer.name, PEOPLE.platformTrainer.name);
});

test('client unlink clears the platform relationship → resolved null', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/trainer/unlink', {});
  assert.strictEqual(res.status, 200);
  const body = await getActive();
  assert.strictEqual(body.source, null);
  assert.strictEqual(body.trainer, null);
});

test('multi-gym determinism: assignment in a second gym still resolves to exactly one GYM trainer', async () => {
  // second gym, member linked there too, trainer assigned in BOTH gyms —
  // the resolver must return one deterministic answer (lowest gym name)
  const resG2 = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `AAAA ${suffix}` });
  const gym2 = (await resG2.json()).gym;
  createdGymIds.push(gym2.id);
  gym2Id = gym2.id;
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gym2.id}/staff`,
    { email: PEOPLE.gymTrainer1.email, gym_role: 'TRAINER' });
  const staff2 = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gym2.id}/staff`)).json();
  const s1in2 = staff2.find((s) => s.email === PEOPLE.gymTrainer1.email)?.id;

  // re-activate the member at gym 1 (was cancelled) + add them to gym 2
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gym.id}/members/${memberId}/reactivate`, {});
  const mem2 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gym2.id}/members`,
    { first_name: 'Member2', email: PEOPLE.member.email })).json();
  gym2MemberId = mem2.id;
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym2.id}/members/${mem2.id}/link-app`, { email: PEOPLE.member.email });

  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer1StaffId });
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym2.id}/members/${mem2.id}/trainer`, { trainer_staff_id: s1in2 });

  const body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.trainer.name, PEOPLE.gymTrainer1.name);
  // listMyTrainers orders by gym name — `AAAA …` sorts first
  assert.strictEqual(body.gym.name, gym2.name);
});

test('gym-trainer guard does not lock out gym-trainer-free members (matrix 8: joins gym, none assigned)', async () => {
  // clean slate: end every ACTIVE gym assignment the previous tests left
  for (const [g, mid] of [[gym.id, memberId], [gym2Id, gym2MemberId]]) {
    const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
      `/gym/${g}/members/${mid}/trainer`)).json();
    for (const a of (Array.isArray(history) ? history : []).filter((x) => x.status === 'ACTIVE')) {
      const end = await api(tokens[PEOPLE.owner.email], 'POST',
        `/gym/${g}/members/${mid}/trainer/${a.id}/end`, { reason: 'cleanup' });
      assert.strictEqual(end.status, 200);
    }
  }
  const before = await getActive();
  assert.strictEqual(before.source, null, 'no trainer of any kind survives the cleanup');

  // a fresh member with a gym link but NO assignment can still invite-connect
  // (this trainer was previously unlinked → the request is a reactivation,
  // which the Profile UI resolves via the preview's restore/fresh choice)
  const code = `AT${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
  await trainerClients.createInviteCode(platformTrainerId, code, new Date(Date.now() + 3600_000));
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/associations/request',
    { invite_code: code, restore_preference: 'restore' });
  assert.strictEqual(res.status, 201);
  const body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.status, 'pending');
});

// ── member-initiated gym disconnect (mobile Settings → Disconnect) ──────────
// Fixture state on entry: the member holds a PENDING USER relationship (the
// reactivation above) and NO ACTIVE gym assignment anywhere.
let memberEndedAssignmentId = null;

test('gym-unlink with no gym assignment → 404, resolution untouched', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/trainer/gym-unlink', {});
  assert.strictEqual(res.status, 404);
  assert.match((await res.json()).error, /No gym-assigned trainer/);
  const body = await getActive();
  assert.strictEqual(body.source, 'USER', 'the pending invite relationship survives a no-op disconnect');
  assert.strictEqual(body.status, 'pending');
});

test('auth gate: /client/trainer/gym-unlink requires a token', async () => {
  const res = await api(null, 'POST', '/client/trainer/gym-unlink', {});
  assert.strictEqual(res.status, 401);
});

test('member disconnects the gym-assigned trainer → falls back to the preserved USER relationship', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer1StaffId });
  assert.strictEqual(res.status, 201);
  let body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.user_trainer.status, 'pending', 'invite relationship rides underneath');

  const out = await api(tokens[PEOPLE.member.email], 'POST', '/client/trainer/gym-unlink', {});
  assert.strictEqual(out.status, 200);
  const payload = await out.json();
  assert.strictEqual(payload.ok, true);
  assert.ok(payload.ended_assignment_id, 'the response names the ended assignment');
  memberEndedAssignmentId = payload.ended_assignment_id;
  // the FRESH resolution rides in the response: the preserved invite
  // relationship surfaces immediately — no second round-trip needed
  assert.strictEqual(payload.active.source, 'USER');
  assert.strictEqual(payload.active.status, 'pending');
  assert.strictEqual(payload.active.trainer.name, PEOPLE.platformTrainer.name);

  // and a plain re-read agrees — no cache split between response and fetch
  body = await getActive();
  assert.strictEqual(body.source, 'USER');
  assert.strictEqual(body.status, 'pending');
});

test('member disconnect is auditable: ENDED + end_reason member_disconnect, actor = member (app)', async () => {
  const row = await query(
    'SELECT status, end_reason FROM gym_trainer_assignments WHERE id = $1',
    [memberEndedAssignmentId]);
  assert.strictEqual(row.rows[0].status, 'ENDED');
  assert.strictEqual(row.rows[0].end_reason, 'member_disconnect');
  const audit = await query(
    `SELECT actor_user_id, actor_label, action FROM audit_logs
     WHERE entity = 'gym_trainer_assignment' AND entity_id = $1 AND action = 'trainer.unassigned'`,
    [String(memberEndedAssignmentId)]);
  assert.ok(audit.rows.length, 'the member-initiated end left an audit trail');
  assert.strictEqual(audit.rows[0].actor_user_id, memberUserId);
  assert.strictEqual(audit.rows[0].actor_label, 'member (app)');
});

test('double disconnect → 404 (nothing left to end)', async () => {
  const res = await api(tokens[PEOPLE.member.email], 'POST', '/client/trainer/gym-unlink', {});
  assert.strictEqual(res.status, 404);
});

test('the gym can reassign after a member disconnect → GYM active again', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gym.id}/members/${memberId}/trainer`, { trainer_staff_id: trainer2StaffId });
  assert.strictEqual(res.status, 201);
  const body = await getActive();
  assert.strictEqual(body.source, 'GYM');
  assert.strictEqual(body.trainer.name, PEOPLE.gymTrainer2.name);

  // leave no ACTIVE assignment behind — keep the shared fixtures clean
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gym.id}/members/${memberId}/trainer`)).json();
  for (const a of (Array.isArray(history) ? history : []).filter((x) => x.status === 'ACTIVE')) {
    const end = await api(tokens[PEOPLE.owner.email], 'POST',
      `/gym/${gym.id}/members/${memberId}/trainer/${a.id}/end`, { reason: 'cleanup' });
    assert.strictEqual(end.status, 200);
  }
});
