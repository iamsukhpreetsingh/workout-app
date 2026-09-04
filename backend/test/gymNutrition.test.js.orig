// Gym nutrition management tests (Phase 12). Real routers, real
// DATABASE_URL, self-cleaning fixtures. Mirrors the Phase 11 suite:
// kinds + validation, versioning, direct assignment for non-app members,
// later app registration, recommended distribution with cross-gym
// isolation, snapshot saves (duplicate save 409, explicit update),
// member leaves/reconnects, archived/draft rules, audit.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymNutrition.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `nu_owner_${suffix}@test.local`, name: 'Nutrition Owner' },
  owner2: { email: `nu_owner2_${suffix}@test.local`, name: 'Other Owner' },
  memberUser: { email: `nu_member_${suffix}@test.local`, name: 'Member Person' },
  memberUser2: { email: `nu_member2_${suffix}@test.local`, name: 'Second Member' },
};
const tokens = {};
let gymA, gymB;
let muscleGainPlan; // the meal-plan example
let memberNoApp, memberWithApp;
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

const MEAL_PLAN = {
  kind: 'MEAL_PLAN',
  title: 'Muscle Gain Plan',
  description: 'High-protein 3-day rotation',
  content: { entries: [
    'Day 1 breakfast: oatmeal, 6 eggs, whey',
    'Day 1 lunch: 200g chicken, rice, broccoli',
    'Day 2 breakfast: paneer bhurji, 2 toast',
  ] },
  targets: { calories: 2800, protein_g: 160, carbs_g: 320, fat_g: 80 },
  tags: ['high-protein', 'gain'],
  status: 'PUBLISHED',
  recommended: true,
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `NutriGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `NutriGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  memberNoApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoApp', phone: '+91 91000 00000' })).json();
  memberWithApp = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WithApp', email: PEOPLE.memberUser.email })).json();
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/link-app`, { email: PEOPLE.memberUser.email });
  assert.strictEqual(link.status, 200);
  const planRes = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'M', price_cents: 100000, status: 'ACTIVE' });
  const plan = await planRes.json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberWithApp.id}/memberships`, { plan_id: plan.id });

  const create = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`, MEAL_PLAN);
  muscleGainPlan = await create.json();
  assert.strictEqual(create.status, 201, `create: ${JSON.stringify(muscleGainPlan)}`);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── creation, kinds, validation ──────────────────────────────────────────

test('create nutrition items of all kinds; version 1; targets attached', async () => {
  assert.strictEqual(muscleGainPlan.version, 1);
  assert.strictEqual(muscleGainPlan.kind, 'MEAL_PLAN');
  assert.strictEqual(muscleGainPlan.targets.calories, 2800);
  assert.strictEqual(muscleGainPlan.content.entries.length, 3);

  const recipe = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'Protein Oats', status: 'PUBLISHED',
      content: { entries: ['80g oats', '1 scoop whey', '200ml milk'] } });
  assert.strictEqual(recipe.status, 201);

  const rec = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'DIET_RECOMMENDATION', title: 'Cutting Guidelines', status: 'PUBLISHED',
      content: { entries: ['Protein at every meal', '500 kcal deficit'] } });
  assert.strictEqual(rec.status, 201);
});

test('validation: kind, title, entries shape, targets bounds, status', async () => {
  const cases = [
    { title: 'X', kind: 'SNACKS' },
    { title: '', kind: 'RECIPE' },
    { title: 'X', kind: 'RECIPE', content: { entries: 'not-an-array' } },
    { title: 'X', kind: 'RECIPE', targets: { calories: -500 } },
    { title: 'X', kind: 'RECIPE', status: 'LIVE' },
  ];
  for (const extra of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`, extra);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
  }
});

test('content edit bumps version; status change does not', async () => {
  const patch = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${muscleGainPlan.id}`,
    { description: 'High-protein 4-day rotation' });
  const after = await patch.json();
  assert.strictEqual(after.version, 2, 'content edit bumps version');
  const pub = await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${muscleGainPlan.id}`,
    { status: 'PUBLISHED' });
  assert.strictEqual((await pub.json()).version, 2, 'status change does not bump');
});

// ── direct assignment (non-app members) ──────────────────────────────────

test('assign to member WITHOUT app account: stored and waiting', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/nutrition-assignments`,
    { item_id: muscleGainPlan.id });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `assign: ${JSON.stringify(body)}`);
  assert.strictEqual(body.item_title, 'Muscle Gain Plan');
  const member = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}`)).json();
  assert.strictEqual(member.app_user_id, null);
});

test('duplicate assignment rejected; drafts and archived items rejected', async () => {
  const dup = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/nutrition-assignments`,
    { item_id: muscleGainPlan.id });
  assert.strictEqual(dup.status, 409);

  const draft = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'Draft Recipe', content: { entries: ['x'] } })).json();
  const assignDraft = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/nutrition-assignments`, { item_id: draft.id });
  assert.strictEqual(assignDraft.status, 400);

  const arch = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'Old Recipe', status: 'PUBLISHED', content: { entries: ['x'] } })).json();
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${arch.id}`,
    { status: 'ARCHIVED' });
  const assignArch = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/nutrition-assignments`, { item_id: arch.id });
  assert.strictEqual(assignArch.status, 409, 'archived content not assignable');
});

test('member leaves: assignment kept; reconnect: intact; later app registration surfaces it', async () => {
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${memberNoApp.id}/cancel`);
  const stored = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${memberNoApp.id}/nutrition-assignments`)).json();
  assert.strictEqual(stored.length, 1, 'assignment kept after leave');
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${memberNoApp.id}/reactivate`);
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${memberNoApp.id}/link-app`, { email: PEOPLE.memberUser2.email });
  assert.strictEqual(link.status, 200, `link: ${JSON.stringify(await link.json())}`);
  const mine = await (await api(tokens[PEOPLE.memberUser2.email], 'GET', '/gym/my/nutrition')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry, 'member sees their gym');
  assert.ok(gymEntry.assigned.some((n) => n.title === 'Muscle Gain Plan'),
    'the stored assignment is now available in the app');
});

// ── recommended distribution ─────────────────────────────────────────────

test('recommended items reach eligible app-connected members; cross-gym blocked', async () => {
  const mine = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/nutrition')).json();
  const gymEntry = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gymEntry.recommended.some((n) => n.title === 'Muscle Gain Plan'));

  const memberB = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'B', email: `nu_b_${suffix}@test.local` })).json();
  createdUserIds.push((await (await api(null, 'POST', '/auth/signup',
    { name: 'B User', email: `nu_bu_${suffix}@test.local`, password: PASSWORD, role: 'user' })).json()).user.id);
  await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymB.id}/members/${memberB.id}/link-app`, { email: `nu_bu_${suffix}@test.local` });
  const mineB = await (await api(tokens[`nu_bu_${suffix}@test.local`], 'GET', '/gym/my/nutrition')).json();
  assert.ok(!JSON.stringify(mineB).includes('Muscle Gain Plan'), 'cross-gym recommendation blocked');
});

// ── snapshot saves ───────────────────────────────────────────────────────

test('member saves → snapshot at current version; duplicate save 409', async () => {
  const save = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/nutrition/${muscleGainPlan.id}/save`);
  const saved = await save.json();
  assert.strictEqual(save.status, 201, `save: ${JSON.stringify(saved)}`);
  assert.strictEqual(saved.saved_version, 2);
  assert.strictEqual(saved.snapshot.targets.calories, 2800);
  const dup = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/nutrition/${muscleGainPlan.id}/save`);
  assert.strictEqual(dup.status, 409);
  globalThis.__saved = saved;
});

test('gym edits to version 3 — saved copy remains at v2 with update hint; explicit update only on request', async () => {
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/nutrition/${muscleGainPlan.id}`,
    { content: { entries: ['Day 1 breakfast: 8 eggs, oats, whey'] }, targets: { calories: 3000, protein_g: 180 } });
  const savedList = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/nutrition/saved')).json();
  const mine = savedList.find((s) => s.item_id === muscleGainPlan.id);
  assert.strictEqual(mine.saved_version, 2, 'personal copy still at v2');
  assert.strictEqual(mine.snapshot.targets.calories, 2800, 'snapshot untouched');
  assert.strictEqual(mine.update_available, true);

  const upd = await api(tokens[PEOPLE.memberUser.email], 'POST',
    `/gym/my/nutrition/saved/${globalThis.__saved.id}/update`);
  assert.strictEqual(upd.status, 200);
  const after = await (await api(tokens[PEOPLE.memberUser.email], 'GET', '/gym/my/nutrition/saved')).json();
  const updated = after.find((s) => s.item_id === muscleGainPlan.id);
  assert.strictEqual(updated.saved_version, 3);
  assert.strictEqual(updated.snapshot.targets.calories, 3000);
  assert.strictEqual(updated.update_available, false);
  const del = await api(tokens[PEOPLE.memberUser.email], 'DELETE',
    `/gym/my/nutrition/saved/${globalThis.__saved.id}`);
  assert.strictEqual(del.status, 200);
});

test('authorization: front desk views the list but cannot create; cross-gym 403', async () => {
  const deskUser = { email: `nu_desk_${suffix}@test.local`, name: 'Nutri Desk' };
  createdUserIds.push((await (await api(null, 'POST', '/auth/signup',
    { ...deskUser, password: PASSWORD, role: 'user' })).json()).user.id);
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: deskUser.email, gym_role: 'FRONT_DESK' });
  await auth(deskUser);
  assert.strictEqual((await api(tokens[deskUser.email], 'GET', `/gym/${gymA.id}/nutrition`)).status, 200);
  assert.strictEqual((await api(tokens[deskUser.email], 'POST', `/gym/${gymA.id}/nutrition`,
    { kind: 'RECIPE', title: 'X' })).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymA.id}/nutrition`)).status, 403);
});

test('audit trail records the nutrition lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  // Phase 13: assignments audit under the unified assignment.* actions
  for (const expected of ['nutrition.created', 'assignment.created', 'nutrition.saved',
    'nutrition.save_updated', 'nutrition.save_removed']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
