// Unified gym content assignments & recommendations tests (Phase 13).
// Real routers, real DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec: ONE assignment system for GymWorkout + GymNutrition
// (content, start date, optional end date, notes), general recommendation
// to eligible connected members, non-app members (app_user_id NULL) whose
// assignments surface on app link, trainer roster scoping, and every edge
// case: duplicate assignment, expired assignment, scheduled assignment,
// archived/draft content, member leaves + reconnects, trainer loses access,
// member later joins the app, content changed after assignment, content
// deleted/archived, unauthorized assignment. Also verifies the legacy
// /workout-assignments + /nutrition-assignments routes still work through
// the unified table.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymContentAssignments.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `p13_owner_${suffix}@test.local`, name: 'Phase Owner' },
  owner2: { email: `p13_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `p13_admin_${suffix}@test.local`, name: 'Phase Admin' },
  trainer1: { email: `p13_tr1_${suffix}@test.local`, name: 'Roster Trainer' },
  trainer2: { email: `p13_tr2_${suffix}@test.local`, name: 'Outside Trainer' },
  desk: { email: `p13_desk_${suffix}@test.local`, name: 'Front Desk' },
  memberUser: { email: `p13_mem1_${suffix}@test.local`, name: 'Member One' },
  memberUser2: { email: `p13_mem2_${suffix}@test.local`, name: 'Member Two' },
  memberUser3: { email: `p13_mem3_${suffix}@test.local`, name: 'Member Three' },
};
const tokens = {};
let gymA, gymB, W1, W2, WDraft, WArch, N1, NDraft, NArch;
let memberNoApp, memberWithApp, memberUnlinked;
let aWithApp;             // ACTIVE assignment of W1 to memberWithApp (dates+notes)
let aScheduled, aExpired; // window edge cases
const createdUserIds = [];
const createdGymIds = [];

// calendar-date helpers (gym timezone is UTC by default in tests)
const dayStr = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const TODAY = dayStr(0);

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

const W_BODY = { title: 'Beginner Strength', difficulty: 'beginner', goal: 'strength',
  estimated_duration_minutes: 45, status: 'PUBLISHED', recommended: true,
  exercises: [{ exercise_name: 'Back Squat', sets: 3, reps: '8-10' }] };
const N_BODY = { kind: 'MEAL_PLAN', title: 'Cutting Plan', status: 'PUBLISHED',
  recommended: true, content: { entries: ['Day 1: …', 'Day 2: …'] },
  targets: { calories: 2000, protein_g: 150 } };

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `Phase13Gym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `Phase13Gym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  // staff: admin, two trainers, front desk
  for (const [person, role] of [
    [PEOPLE.admin, 'ADMIN'], [PEOPLE.trainer1, 'TRAINER'],
    [PEOPLE.trainer2, 'TRAINER'], [PEOPLE.desk, 'FRONT_DESK'],
  ]) {
    const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
      { email: person.email, gym_role: role });
    assert.strictEqual(r.status, 201, `staff ${person.email} as ${role}`);
  }

  // members: one app-linked with an ACTIVE membership term, one never-linked,
  // one linked but WITHOUT a membership term (recommendation-ineligible)
  memberNoApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoApp', phone: '+91 92000 00001' })).json();
  memberWithApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WithApp', email: PEOPLE.memberUser.email })).json();
  assert.strictEqual((await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/link-app`, { email: PEOPLE.memberUser.email })).status, 200);
  const planId = (await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'M', price_cents: 100000, status: 'ACTIVE' })).json()).id;
  assert.strictEqual((await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`,
    { plan_id: planId })).status, 201);
  memberUnlinked = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoTerm', email: PEOPLE.memberUser2.email })).json();
  assert.strictEqual((await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberUnlinked.id}/link-app`, { email: PEOPLE.memberUser2.email })).status, 200);

  // content: published/recommended, draft and archived variants for both types
  W1 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`, W_BODY)).json();
  W2 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Renewable Block', status: 'PUBLISHED',
      exercises: [{ exercise_name: 'Row', sets: 3, reps: '10' }] })).json();
  WDraft = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Draft W', exercises: [{ exercise_name: 'X', sets: 1 }] })).json();
  WArch = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/workouts`,
    { title: 'Arch W', status: 'PUBLISHED', exercises: [{ exercise_name: 'X', sets: 1 }] })).json();
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${WArch.id}`, { status: 'ARCHIVED' });
  N1 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`, N_BODY)).json();
  NDraft = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'Draft N', content: { entries: ['x'] } })).json();
  NArch = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'Arch N', status: 'PUBLISHED', content: { entries: ['x'] } })).json();
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${NArch.id}`, { status: 'ARCHIVED' });
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── creation: content + dates + notes ────────────────────────────────────

test('unified assignment: member + content + start/end dates + notes; version stamped', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: W1.id,
    starts_on: TODAY, ends_on: dayStr(14), notes: 'Start with 3 sessions/week.',
  });
  aWithApp = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(aWithApp));
  assert.strictEqual(aWithApp.content_type, 'WORKOUT');
  assert.strictEqual(aWithApp.starts_on, TODAY);
  assert.strictEqual(aWithApp.ends_on, dayStr(14));
  assert.strictEqual(aWithApp.notes, 'Start with 3 sessions/week.');
  assert.strictEqual(aWithApp.assigned_version, W1.version, 'version stamped at assignment time');
  assert.strictEqual(aWithApp.content_title, 'Beginner Strength');
  assert.strictEqual(aWithApp.effective_status, 'ACTIVE');
  assert.strictEqual(aWithApp.workout_title, 'Beginner Strength', 'compat field present');
});

test('starts_on defaults to today (gym timezone) when omitted', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(body));
  assert.strictEqual(body.starts_on, TODAY, 'default = today in the gym timezone (UTC)');
  assert.strictEqual(body.ends_on, null);
  assert.strictEqual(body.notes, null);
  assert.strictEqual(body.effective_status, 'ACTIVE');
});

test('duplicate non-expired ACTIVE assignment rejected (409) — per content type', async () => {
  const dup = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: W1.id,
  });
  assert.strictEqual(dup.status, 409);
  const dupN = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  assert.strictEqual(dupN.status, 409, 'duplicate nutrition assignment rejected too');
  // same content to a DIFFERENT member is fine
  const other = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: W1.id,
  });
  assert.strictEqual(other.status, 201);
});

test('validation: dates, window order, notes length, payload shape', async () => {
  const cases = [
    { member_id: memberNoApp.id, content_type: 'WORKOUT', starts_on: '2026-02-31', workout_id: W1.id },
    { member_id: memberNoApp.id, content_type: 'WORKOUT', starts_on: 'not-a-date', workout_id: W1.id },
    { member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: W1.id, starts_on: TODAY, ends_on: dayStr(-1) },
    { member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: W1.id, notes: 'x'.repeat(1001) },
    { member_id: memberNoApp.id, content_type: 'UNKNOWN', workout_id: W1.id },
    { member_id: memberNoApp.id, content_type: 'WORKOUT' },                       // no workout_id
    { member_id: memberNoApp.id, content_type: 'NUTRITION', workout_id: W1.id },  // wrong id kind
    { content_type: 'WORKOUT', workout_id: W1.id },                               // no member
  ];
  for (const body of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, body);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)} — got ${res.status}`);
  }
});

test('draft content → 400; archived content → 409 (both content types)', async () => {
  const dW = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`,
    { member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: WDraft.id });
  assert.strictEqual(dW.status, 400, 'draft workout not assignable');
  const aW = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`,
    { member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: WArch.id });
  assert.strictEqual(aW.status, 409, 'archived workout not assignable');
  const dN = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`,
    { member_id: memberNoApp.id, content_type: 'NUTRITION', item_id: NDraft.id });
  assert.strictEqual(dN.status, 400, 'draft nutrition not assignable');
  const aN = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`,
    { member_id: memberNoApp.id, content_type: 'NUTRITION', item_id: NArch.id });
  assert.strictEqual(aN.status, 409, 'archived nutrition not assignable');
});

// ── scheduling & expiry (computed, no cron) ──────────────────────────────

test('future starts_on → SCHEDULED; hidden from the member until the window opens', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'NUTRITION', item_id: N1.id, starts_on: dayStr(7),
  });
  aScheduled = await res.json();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(aScheduled.effective_status, 'SCHEDULED');

  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/content')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry, 'member sees their gym');
  assert.ok(!gymEntry.nutrition.assigned.some((n) => n.assignment_id === aScheduled.id),
    'scheduled nutrition hidden from member until starts_on');
  // scheduling over the same pair is still a duplicate while queued
  const dup = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'NUTRITION', item_id: N1.id, starts_on: dayStr(9),
  });
  assert.strictEqual(dup.status, 409, 'second queued window rejected — PATCH the first instead');
});

test('PATCH moves the window: scheduled nutrition becomes ACTIVE and visible', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/assignments/${aScheduled.id}`,
    { starts_on: TODAY, notes: 'Cut starts now — 2000 kcal.' });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.effective_status, 'ACTIVE');
  assert.strictEqual(body.notes, 'Cut starts now — 2000 kcal.');
  aScheduled.notes = body.notes;

  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/content')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  const row = gymEntry.nutrition.assigned.find((n) => n.assignment_id === aScheduled.id);
  assert.ok(row, 'window opened → member now sees the assignment');
  assert.strictEqual(row.notes, 'Cut starts now — 2000 kcal.');
  assert.strictEqual(row.content_type, 'NUTRITION');
});

test('past ends_on → EXPIRED: member view drops it; staff list still shows it; re-assign supersedes', async () => {
  // expired W2 window for memberNoApp (who already holds an in-window W1 —
  // a different workout, so this is independent)
  const exp = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: W2.id,
    starts_on: dayStr(-10), ends_on: dayStr(-1), notes: 'old block',
  });
  aExpired = await exp.json();
  assert.strictEqual(exp.status, 201, JSON.stringify(aExpired));
  assert.strictEqual(aExpired.effective_status, 'EXPIRED');

  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/assignments?effective_status=EXPIRED`)).json();
  assert.ok(list.some((a) => a.id === aExpired.id), 'staff list can filter EXPIRED');

  // member view: expired rows drop off — but memberNoApp has no app link yet,
  // so verify through the unified member-history endpoint instead
  const hist = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/assignments`)).json();
  const expiredRow = hist.find((a) => a.id === aExpired.id);
  assert.strictEqual(expiredRow.effective_status, 'EXPIRED');

  // re-assign the same workout → expired row superseded, new ACTIVE row created
  const re = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: W2.id,
    starts_on: TODAY, notes: 'renewed block',
  });
  const renewed = await re.json();
  assert.strictEqual(re.status, 201, 'renewal over an EXPIRED row is allowed');
  const sup = await query(
    "SELECT status, end_reason, ended_on::text AS ended_on FROM gym_content_assignments WHERE id = $1",
    [aExpired.id]
  );
  assert.strictEqual(sup.rows[0].status, 'ENDED');
  assert.strictEqual(sup.rows[0].end_reason, 'superseded');
  assert.strictEqual(sup.rows[0].ended_on, dayStr(-1), 'ended on its own expiry date');
  assert.strictEqual(renewed.effective_status, 'ACTIVE');
  assert.strictEqual(renewed.notes, 'renewed block');
});

// ── end / history / the old UNIQUE defect ────────────────────────────────

test('end assignment → history kept; second end rejected; repeated assign→end cycles work', async () => {
  const end1 = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments/${aWithApp.id}/end`,
    { reason: 'completed' });
  assert.strictEqual(end1.status, 200, JSON.stringify(await end1.json()));
  const end2 = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments/${aWithApp.id}/end`, {});
  assert.strictEqual(end2.status, 400, 'already ended');
  const ended = await query(
    'SELECT end_reason, ended_on::text AS ended_on FROM gym_content_assignments WHERE id = $1', [aWithApp.id]);
  assert.strictEqual(ended.rows[0].end_reason, 'completed');
  assert.strictEqual(ended.rows[0].ended_on, TODAY);

  // TWO full assign→end cycles on the same pair — the Phase 11 UNIQUE
  // (workout, member, status) constraint could not survive this; the
  // unified table keeps unlimited ENDED history
  for (let i = 0; i < 2; i++) {
    const re = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
      member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: W1.id, notes: `cycle ${i + 1}`,
    });
    assert.strictEqual(re.status, 201, `re-assign cycle ${i + 1}`);
    const row = await re.json();
    const stop = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments/${row.id}/end`,
      { reason: `cycle end ${i + 1}` });
    assert.strictEqual(stop.status, 200, `end cycle ${i + 1}`);
  }
  const hist = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/assignments?content_type=WORKOUT`)).json();
  assert.ok(hist.filter((a) => a.status === 'ENDED').length >= 3, 'full ENDED history kept');
});

// ── member surfaces: non-app members, app linking, recommendations ───────

test('member later joins the app: stored assignments surface; recommendation needs a term', async () => {
  // memberNoApp (assigned W1 + W2-renewed + N1 active, no membership term)
  // links a DEDICATED app account now (one app user ↔ one member row per gym
  // keeps member resolution unambiguous)
  const linked = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/link-app`, { email: PEOPLE.memberUser3.email });
  assert.strictEqual(linked.status, 200);

  const mine = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/content')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry, 'linked member sees the gym');
  const wAssigned = gymEntry.workouts.assigned.find((w) => w.title === 'Beginner Strength');
  assert.ok(wAssigned, 'stored workout assignment surfaced after app link');
  assert.ok(wAssigned.exercises.length >= 1, 'workout exercises ride along');
  assert.ok(gymEntry.nutrition.assigned.some((n) => n.title === 'Cutting Plan'),
    'stored nutrition assignment surfaced too');
  assert.strictEqual(gymEntry.workouts.recommended.length, 0,
    'no ACTIVE membership term → recommendations withheld');
  assert.strictEqual(gymEntry.nutrition.recommended.length, 0,
    'no ACTIVE membership term → nutrition recommendations withheld');
});

test('member WITH an active term sees recommendations AND assignments (both types)', async () => {
  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/content')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry.workouts.recommended.some((w) => w.title === 'Beginner Strength'),
    'recommended workout present');
  assert.ok(gymEntry.nutrition.recommended.some((n) => n.title === 'Cutting Plan'),
    'recommended nutrition present');
  assert.ok(gymEntry.nutrition.assigned.some((n) => n.assignment_id === aScheduled.id),
    'active-window assignment present');
});

test('legacy /my/workouts and /my/nutrition keep their response shape (mobile compat)', async () => {
  const w = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/workouts')).json();
  const gymEntry = w.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry.assigned[0].assignment_id, 'assignment_id present');
  assert.ok('exercises' in gymEntry.assigned[0], 'exercises present');
  const n = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/nutrition')).json();
  const nEntry = n.find((g) => g.gym_id === gymA.id);
  assert.ok(nEntry.assigned[0].kind, 'kind present');
});

// ── member leaves / content changed / content archived ───────────────────

test('member leaves: rows survive; member view empties; reactivate restores; new assigns blocked', async () => {
  const leave = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/cancel`);
  assert.strictEqual(leave.status, 200);
  const mine = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/content')).json();
  assert.ok(!mine.some((g) => g.gym_id === gymA.id), 'left member sees nothing');
  const hist = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/assignments`)).json();
  assert.ok(hist.length >= 3, 'assignment rows survived the leave');
  const blocked = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  assert.strictEqual(blocked.status, 400, 'no new assignments for a CANCELLED member');
  assert.strictEqual((await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/reactivate`)).status, 200);
  const restored = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/content')).json();
  assert.ok(restored.some((g) => g.gym_id === gymA.id), 'reactivation restores the member view');
});

test('content changed after assignment: version bump flags content_updated', async () => {
  const before = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/assignments?member_id=${memberWithApp.id}&content_type=NUTRITION`)).json();
  const row = before.find((a) => a.id === aScheduled.id);
  assert.strictEqual(row.content_updated, false, 'no bump yet');
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${N1.id}`,
    { description: 'v2 guidance' });
  assert.strictEqual((await edit.json()).version, N1.version + 1, 'content edit bumps version');
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/assignments?member_id=${memberWithApp.id}&content_type=NUTRITION`)).json();
  const afterRow = after.find((a) => a.id === aScheduled.id);
  assert.strictEqual(afterRow.content_updated, true, 'content_changed_after_assignment detected');
  assert.strictEqual(afterRow.assigned_version, N1.version, 'stamp keeps the assignment-time version');
  assert.strictEqual(afterRow.item_version, N1.version + 1);
});

test('content archived AFTER assignment: member view hides it, row retained, reversible', async () => {
  // archive W1 → member (with term) no longer sees it in recommended/assigned
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${W1.id}`, { status: 'ARCHIVED' });
  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/content')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(!gymEntry.workouts.recommended.some((w) => w.title === 'Beginner Strength'),
    'archived content leaves the recommended surface');
  assert.ok(!JSON.stringify(gymEntry.workouts.assigned).includes('Beginner Strength'),
    'archived content leaves the assigned surface');
  // row still there for the gym (reversible)
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/assignments?content_type=WORKOUT`)).json();
  assert.ok(list.some((a) => a.workout_id === W1.id), 'assignment row retained');
  // restore → member sees it again (memberNoApp holds an in-window W1 row)
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/workouts/${W1.id}`, { status: 'PUBLISHED' });
  const restored = await (await api(tokens[PEOPLE.memberUser3.email], 'GET', '/gym/my/content')).json();
  assert.ok(restored.find((g) => g.gym_id === gymA.id).workouts.assigned.some((w) => w.title === 'Beginner Strength'),
    'restoring content brings the assignment back');
});

// ── permissions & trainer roster scoping ─────────────────────────────────

test('unauthorized assignment: front desk 403, trainer without roster 403, cross-gym 403', async () => {
  const desk = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  assert.strictEqual(desk.status, 403, 'front desk has neither members.manage nor assignments.manage');

  const t1 = await api(tokens[PEOPLE.trainer1.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  assert.strictEqual(t1.status, 403, 'trainer with no roster cannot assign');

  const cross = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'NUTRITION', item_id: N1.id,
  });
  assert.strictEqual(cross.status, 403, 'other gym owner has no context for gym A');
});

test('trainer assigns within roster: allowed; outside roster: 403', async () => {
  // put memberWithApp on trainer1's roster
  const trainersList = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/trainers`)).json();
  const t1 = trainersList.find((t) => t.email === PEOPLE.trainer1.email);
  assert.ok(t1, 'trainer1 in the assignable list');
  const roster = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer`,
    { trainer_staff_id: t1.trainer_staff_id });
  assert.strictEqual(roster.status, 201, `roster assignment: ${JSON.stringify(await roster.json())}`);

  const okRes = await api(tokens[PEOPLE.trainer1.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: W1.id,
    starts_on: TODAY, ends_on: dayStr(7), notes: 'trainer block',
  });
  const trainerAssignment = await okRes.json();
  assert.strictEqual(okRes.status, 201, `trainer assigns to own roster member: ${JSON.stringify(trainerAssignment)}`);

  // 403 (scope) must win over any content-level 400/409 — WDraft is DRAFT,
  // so a broken scope check would surface 400 instead of 403
  const out = await api(tokens[PEOPLE.trainer2.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: WDraft.id,
  });
  assert.strictEqual(out.status, 403, 'trainer2 (no roster) blocked — 403 does not leak the member');
  const selfRoster = await api(tokens[PEOPLE.trainer1.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberNoApp.id, content_type: 'WORKOUT', workout_id: WDraft.id,
  });
  assert.strictEqual(selfRoster.status, 403, 'a member outside the roster is out of scope for trainer1');

  // trainer can edit + end their roster member's assignment
  const patch = await api(tokens[PEOPLE.trainer1.email], 'PATCH',
    `/gym/${gymA.id}/assignments/${trainerAssignment.id}`, { notes: 'trainer adjusted' });
  assert.strictEqual(patch.status, 200, 'trainer edits own roster assignment');
  const endedByTrainer = await api(tokens[PEOPLE.trainer1.email], 'POST',
    `/gym/${gymA.id}/assignments/${trainerAssignment.id}/end`, { reason: 'cycle done' });
  assert.strictEqual(endedByTrainer.status, 200, 'trainer ends own roster assignment');
});

test('gym-wide list is trainer-scoped and q-searchable; admin/owner see everything', async () => {
  const t1view = await (await api(tokens[PEOPLE.trainer1.email], 'GET',
    `/gym/${gymA.id}/assignments`)).json();
  assert.ok(t1view.length >= 1, 'trainer sees roster rows');
  assert.ok(t1view.every((a) => a.member_id === memberWithApp.id),
    'trainer sees ONLY their roster members');

  const adminView = await (await api(tokens[PEOPLE.admin.email], 'GET',
    `/gym/${gymA.id}/assignments?q=NoApp`)).json();
  assert.ok(adminView.length >= 1, 'admin q-search by member name works');
  const byType = await (await api(tokens[PEOPLE.admin.email], 'GET',
    `/gym/${gymA.id}/assignments?content_type=NUTRITION&effective_status=ACTIVE`)).json();
  assert.ok(byType.every((a) => a.content_type === 'NUTRITION' && a.effective_status === 'ACTIVE'),
    'combined filters work');
});

test('trainer loses access (roster end): cannot manage that member anymore', async () => {
  // trainer1's roster assignment to memberWithApp
  const rosterList = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer`)).json();
  const activeRoster = rosterList.find((r) => r.status === 'ACTIVE');
  assert.ok(activeRoster, 'trainer1 has an active roster row');
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/trainer/${activeRoster.id}/end`, { reason: 'reassigned' });

  const blocked = await api(tokens[PEOPLE.trainer1.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberWithApp.id, content_type: 'WORKOUT', workout_id: WDraft.id,
  });
  assert.strictEqual(blocked.status, 403, 'roster loss revokes assignment rights immediately');
  const view = await api(tokens[PEOPLE.trainer1.email], 'GET',
    `/gym/${gymA.id}/members/${memberWithApp.id}/assignments`);
  assert.strictEqual(view.status, 403, 'even reading the ex-member history is blocked');
});

test('admin (members.manage) assigns; PATCH validation on windows; ENDED rows immutable', async () => {
  const res = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gymA.id}/assignments`, {
    member_id: memberUnlinked.id, content_type: 'NUTRITION', item_id: N1.id,
    starts_on: TODAY, notes: 'admin assigned',
  });
  assert.strictEqual(res.status, 201, 'ADMIN holds members.manage');
  const row = await res.json();
  const bad = await api(tokens[PEOPLE.admin.email], 'PATCH', `/gym/${gymA.id}/assignments/${row.id}`,
    { ends_on: dayStr(-1) });
  assert.strictEqual(bad.status, 400, 'ends_on before starts_on rejected on PATCH');
  const end = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gymA.id}/assignments/${row.id}/end`, {});
  assert.strictEqual(end.status, 200);
  const editEnded = await api(tokens[PEOPLE.admin.email], 'PATCH', `/gym/${gymA.id}/assignments/${row.id}`,
    { notes: 'too late' });
  assert.strictEqual(editEnded.status, 400, 'ENDED rows cannot be edited');
});

// ── legacy compatibility routes (Phase 11/12 shapes over the unified table)

test('legacy endpoints keep working: bare assign, domain history, domain end', async () => {
  const assign = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberUnlinked.id}/workout-assignments`, { workout_id: W1.id });
  const legacy = await assign.json();
  assert.strictEqual(assign.status, 201, `legacy workout assign: ${JSON.stringify(legacy)}`);
  assert.strictEqual(legacy.workout_title, 'Beginner Strength');
  assert.ok('difficulty' in legacy === false || legacy.difficulty === undefined, 'shape unchanged');

  const hist = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberUnlinked.id}/workout-assignments`)).json();
  const row = hist.find((a) => a.workout_id === W1.id);
  assert.ok(row, 'legacy history lists the row');
  assert.strictEqual(row.workout_title, 'Beginner Strength');
  assert.ok('difficulty' in row && 'goal' in row, 'Phase 11 fields present');

  const end = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/workout-assignments/${legacy.id}/end`, { reason: 'legacy end' });
  assert.strictEqual(end.status, 200);

  const assignN = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberUnlinked.id}/nutrition-assignments`, { item_id: NDraft.id });
  assert.strictEqual(assignN.status, 400, 'legacy nutrition assign still guards drafts');
});

test('cross-gym isolation on the unified list and member surface', async () => {
  const res = await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/assignments`);
  assert.strictEqual(res.status, 403);
  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/content')).json();
  assert.ok(!JSON.stringify(mine).includes('Phase13Gym B'), 'no foreign gym data');
});

test('audit trail records the unified assignment lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['assignment.created', 'assignment.updated', 'assignment.ended']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
