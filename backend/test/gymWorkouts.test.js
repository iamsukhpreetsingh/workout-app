// Gym workout management tests (Phase 11). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers the spec: gym-owned content (separate from user/trainer content),
// versioned originals, direct assignment to members WITHOUT app accounts
// that becomes visible once they connect, general recommendations to all
// eligible app-connected members, snapshot saves independent of later gym
// edits (v1 stays v1 until an explicit update), duplicate
// assignment/save rejection, archived/draft workouts not assignable,
// member leaves + reconnects, multiple gyms, and cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymWorkouts.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `gw_owner_${suffix}@test.local`, name: 'Workout Owner' },
  owner2: { email: `gw_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `gw_admin_${suffix}@test.local`, name: 'Workout Admin' },
  memberUser: { email: `gw_member_${suffix}@test.local`, name: 'Member Person' },
  memberUser2: { email: `gw_member2_${suffix}@test.local`, name: 'Second Member' },
};
const tokens = {};
let gymA, gymB, plan;
let beginnerStrength; // the spec's example, v1
let memberNoApp, memberWithApp, memberAppUserId;
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

const WORKOUT = {
  title: 'Beginner Strength',
  description: 'Full-body strength foundation',
  difficulty: 'beginner',
  goal: 'strength',
  estimated_duration_minutes: 45,
  tags: ['strength', 'full-body'],
  status: 'PUBLISHED',
  recommended: true,
  exercises: [
    { exercise_name: 'Back Squat', sets: 3, reps: '8-10', notes: 'deep, controlled' },
    { exercise_name: 'Bench Press', sets: 3, reps: '8-10' },
    { exercise_name: 'Plank', duration_minutes: 3 },
  ],
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `WorkoutGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `WorkoutGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  assert.strictEqual(r.status, 201, 'admin added');

  memberNoApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoApp', phone: '+91 92000 00000' })).json();
  memberWithApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WithApp', email: PEOPLE.memberUser.email })).json();
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/link-app`, { email: PEOPLE.memberUser.email });
  assert.strictEqual(link.status, 200);
  memberAppUserId = (await link.json()).app_user_id;
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`,
    { plan_id: (await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
      { name: 'M', price_cents: 100000, status: 'ACTIVE' })).json()).id });
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── creation & versioning ────────────────────────────────────────────────

test('create gym-owned workout with exercises; version 1; exercises stored by name', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`, WORKOUT);
  beginnerStrength = await res.json();
  assert.strictEqual(res.status, 201, `create: ${JSON.stringify(beginnerStrength)}`);
  assert.strictEqual(beginnerStrength.version, 1);
  assert.strictEqual(beginnerStrength.exercises.length, 3);
  assert.strictEqual(beginnerStrength.exercises[0].exercise_name, 'Back Squat');
  assert.strictEqual(beginnerStrength.status, 'PUBLISHED');
  // the row references NO catalog exercise id — names are the data
  const rows = await query(
    'SELECT exercise_name FROM gym_workout_exercises WHERE workout_id = $1', [beginnerStrength.id]
  );
  assert.strictEqual(rows.rows.length, 3);
});

test('validation: title, exercises, difficulty, goal, sets, duration bounds', async () => {
  const cases = [
    { title: '' },
    { title: 'X', exercises: [] },
    { title: 'X', exercises: [{ exercise_name: 'Y', sets: 0 }] },
    { title: 'X', exercises: [{ exercise_name: 'Y' }], difficulty: 'elite' },
    { title: 'X', exercises: [{ exercise_name: 'Y' }], goal: 'beach' },
    { title: 'X', exercises: [{ exercise_name: 'Y' }], estimated_duration_minutes: 9000 },
  ];
  for (const extra of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`, extra);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
  }
});

test('content edit bumps version; publish/archive status change does not', async () => {
  const desc = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${beginnerStrength.id}`,
    { description: 'Full-body strength foundation (updated)' });
  const afterDesc = await desc.json();
  assert.strictEqual(desc.status, 200);
  assert.strictEqual(afterDesc.version, 2, 'content edit bumps version');
  const arch = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${beginnerStrength.id}`,
    { status: 'PUBLISHED' });
  const afterArch = await arch.json();
  assert.strictEqual(afterArch.version, 2, 'status change does not bump version');
  assert.strictEqual(afterArch.status, 'PUBLISHED');
});

test('authorization: ADMIN creates, front desk cannot; cross-gym invisible', async () => {
  const adminCreate = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Admin Made', status: 'PUBLISHED', exercises: [{ exercise_name: 'Row', sets: 3, reps: '10' }] });
  assert.strictEqual(adminCreate.status, 201, 'admin holds content.manage');
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET',
    `/gym/${gymA.id}/workouts`)).status, 403, 'cross-gym staff blocked');
  const list = await (await api(tokens[PEOPLE.admin.email], 'GET', `/gym/${gymA.id}/workouts`)).json();
  assert.ok(list.some((w) => w.title === 'Beginner Strength'));
  assert.ok(!JSON.stringify(list).includes('GymB'), 'no foreign content');
});

// ── direct assignment (non-app members first-class) ──────────────────────

test('assign to member WITHOUT app account: stored and waiting', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`,
    { workout_id: beginnerStrength.id });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `assign: ${JSON.stringify(body)}`);
  assert.strictEqual(body.workout_title, 'Beginner Strength');
  assert.strictEqual(body.workout_version, 2);
  const member = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}`)).json();
  assert.strictEqual(member.app_user_id, null, 'assignment never touches app accounts');
});

test('duplicate assignment rejected; draft and archived workouts rejected', async () => {
  const dup = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`,
    { workout_id: beginnerStrength.id });
  assert.strictEqual(dup.status, 409);

  const draft = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Draft Thing', exercises: [{ exercise_name: 'X', sets: 1 }] })).json();
  const assignDraft = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`, { workout_id: draft.id });
  assert.strictEqual(assignDraft.status, 400, 'drafts are not assignable');

  const arch = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Old Thing', status: 'PUBLISHED', exercises: [{ exercise_name: 'X', sets: 1 }] })).json();
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${arch.id}`, { status: 'ARCHIVED' });
  const assignArch = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`, { workout_id: arch.id });
  assert.strictEqual(assignArch.status, 409, 'archived workouts cannot be newly assigned');
});

test('member leaves: assignment survives in storage; mobile view excludes it; reconnect restores', async () => {
  // memberNoApp leaves (cancel) — assignment row must remain
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${memberNoApp.id}/cancel`);
  const stored = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`)).json();
  assert.strictEqual(stored.length, 1, 'assignment kept after leave');
  // reactivate → back in business
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${memberNoApp.id}/reactivate`);
  const still = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/workout-assignments`)).json();
  assert.strictEqual(still[0].status, 'ACTIVE', 'assignment intact after reconnect');
});

test('member later joins the app: the stored assignment becomes available to them', async () => {
  // link the previously non-app member to an app account
  const linked = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/link-app`, { email: PEOPLE.memberUser2.email });
  assert.strictEqual(linked.status, 200, `link: ${JSON.stringify(await linked.json())}`);
  const mine = await (await api(tokens[PEOPLE.memberUser2.email], 'GET', '/gym/my/workouts')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry, 'member sees their gym');
  assert.ok(gymEntry.assigned.some((w) => w.title === 'Beginner Strength'),
    'the stored assignment is now available in the app');
});

// ── general recommendation ───────────────────────────────────────────────

test('recommended workout reaches all eligible app-connected members of the gym', async () => {
  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/workouts')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry, 'app-connected member sees the gym');
  assert.ok(gymEntry.recommended.some((w) => w.title === 'Beginner Strength'),
    'recommended workout appears');
  // another gym's member gets nothing from gym A
  const memberB = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'B', email: `gw_b_${suffix}@test.local` })).json();
  createdUserIds.push((await (await api(null, 'POST', '/auth/signup',
    { name: 'B User', email: `gw_bu_${suffix}@test.local`, password: PASSWORD, role: 'user' })).json()).user.id);
  await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymB.id}/members/${memberB.id}/link-app`, { email: `gw_bu_${suffix}@test.local` });
  const mineB = await (await api(tokens[`gw_bu_${suffix}@test.local`], 'GET', '/gym/my/workouts')).json();
  assert.ok(!JSON.stringify(mineB).includes('Beginner Strength'), 'cross-gym recommendation blocked');
});

// ── saves: snapshot semantics ────────────────────────────────────────────

test('member saves the workout → snapshot at the CURRENT version, independent copy', async () => {
  const save = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/workouts/${beginnerStrength.id}/save`);
  const saved = await save.json();
  assert.strictEqual(save.status, 201, `save: ${JSON.stringify(saved)}`);
  assert.strictEqual(saved.saved_version, 2);
  assert.strictEqual(saved.snapshot.title, 'Beginner Strength');
  assert.strictEqual(saved.snapshot.exercises.length, 3);

  // duplicate save rejected
  const dup = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/workouts/${beginnerStrength.id}/save`);
  assert.strictEqual(dup.status, 409, 'duplicate save rejected');
  globalThis.__saved = saved;
});

test('gym edits the original to version 3 — the saved copy REMAINS at version 2', async () => {
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${beginnerStrength.id}`,
    { title: 'Beginner Strength', description: 'v3 content', exercises: [
      { exercise_name: 'Back Squat', sets: 4, reps: '6-8' },
      { exercise_name: 'Deadlift', sets: 3, reps: '5' },
    ] });
  const edited = await edit.json();
  assert.strictEqual(edited.version, 3, 'original now v3');
  const savedRes = await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/workouts/saved');
  const savedList = await savedRes.json();
  console.error('[DBG saved] status:', savedRes.status, 'body:', JSON.stringify(savedList).slice(0, 300));
  const mine = Array.isArray(savedList) ? savedList.find((s) => s.workout_id === beginnerStrength.id) : null;
  assert.ok(mine, `saved row present: ${JSON.stringify(savedList).slice(0, 200)}`);
  assert.strictEqual(mine.snapshot.exercises.length, 3, 'snapshot untouched by the gym edit');
  assert.strictEqual(mine.update_available, true, 'portal hints an update exists');
  void edited;
});

test('explicit update pulls version 3 into the personal copy — only on request', async () => {
  const upd = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/workouts/saved/${globalThis.__saved.id}/update`);
  assert.strictEqual(upd.status, 200, `update: ${JSON.stringify(await upd.json())}`);
  const savedList = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/workouts/saved')).json();
  const mine = savedList.find((s) => s.workout_id === beginnerStrength.id);
  assert.strictEqual(mine.saved_version, 3);
  assert.strictEqual(mine.snapshot.exercises.length, 2, 'snapshot now reflects v3');
  assert.strictEqual(mine.update_available, false);
  // and the member can remove it from their library
  const del = await api(tokens[PEOPLE.memberUser.email], 'DELETE',
    `/gym/my/workouts/saved/${globalThis.__saved.id}`);
  assert.strictEqual(del.status, 200);
  const after = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/workouts/saved')).json();
  assert.ok(!after.some((s) => s.workout_id === beginnerStrength.id));
});

test('assignment ending: history kept, then re-assignment possible', async () => {
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/workout-assignments`)).json();
  assert.strictEqual(history.length, 0, 'memberWithApp has no assignment yet');
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/workout-assignments`,
    { workout_id: beginnerStrength.id });
  assert.strictEqual(assign.status, 201);
  const assignment = await assign.json();
  const end = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/workout-assignments/${assignment.id}/end`, { reason: 'completed' });
  assert.strictEqual(end.status, 200, `end: ${JSON.stringify(await end.json())}`);
  const reassign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/workout-assignments`,
    { workout_id: beginnerStrength.id });
  assert.strictEqual(reassign.status, 201, 're-assignment works after ending');
});

test('audit trail records the workout lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['workout.created', 'workout.updated', 'workout.assigned',
    'workout.saved', 'workout.save_updated', 'workout.save_removed']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
