// Signup body-profile tests (Mobile M10). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers: signup (user role) with DOB/gender/weight/height seeds the intake
// profile (age derived from DOB); trainer signups skip it; validation
// rejections (bad DOB/gender/ranges) never create the user; the intake form
// pre-populates from the seeded row (GET /client/intake-profile);
// completed_at stays NULL (a seeded profile is not a completed intake);
// linking backfills the gym member's empty fields; desk-entered values are
// never overwritten; app_profile overlay serves already-linked members;
// gym portal sees the values; cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymSignupProfile.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');
const clientRoutes = require('../src/routes/client');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `sp_owner_${suffix}@test.local`, name: 'Signup Owner' },
  owner2: { email: `sp_owner2_${suffix}@test.local`, name: 'Other Owner' },
};
const tokens = {};
let gymA;
const createdUserIds = [];
const createdGymIds = [];

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

async function signup(person, profile) {
  const res = await api(null, 'POST', '/auth/signup', { password: PASSWORD, role: 'user', ...person, profile });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}: ${JSON.stringify(body)}`);
  createdUserIds.push(body.user.id);
  return body;
}

async function loginToken(email) {
  const res = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `login ${email}`);
  tokens[email] = body.accessToken;
  return body.accessToken;
}

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  app.use('/client', clientRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) {
    const b = await signup(person);
    tokens[person.email] = b.accessToken;
  }
  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `SignupGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── signup seeds the intake profile ──────────────────────────────────────

test('user signup with body profile seeds the intake profile (age derived from DOB)', async () => {
  const person = { name: 'Seeded User', email: `sp_seed_${suffix}@test.local`, password: PASSWORD, role: 'user' };
  const created = await signup(person, {
    date_of_birth: '1998-03-15', gender: 'female', height_cm: 168, weight_kg: 62,
  });
  tokens[person.email] = created.accessToken;

  const row = await query(
    'SELECT date_of_birth, gender, age, height_cm, weight_kg, completed_at FROM client_intake_profiles WHERE client_user_id = $1',
    [created.user.id]
  );
  assert.strictEqual(row.rows.length, 1, 'intake profile row created');
  const p = row.rows[0];
  assert.strictEqual(p.date_of_birth, '1998-03-15', 'DOB stored as a calendar date');
  assert.strictEqual(p.gender, 'female');
  const expectedAge = Math.floor((Date.now() - new Date('1998-03-15T00:00:00Z').getTime()) / (365.25 * 86400000));
  assert.strictEqual(p.age, expectedAge, 'age derived from DOB');
  assert.strictEqual(Number(p.height_cm), 168);
  assert.strictEqual(Number(p.weight_kg), 62);
  assert.strictEqual(p.completed_at, null, 'seeded profile is NOT a completed intake');
});

test('trainer signup ignores the body profile; user without profile gets no row', async () => {
  const trainer = await signup(
    { name: 'T', email: `sp_tr_${suffix}@test.local`, password: PASSWORD, role: 'trainer' },
    { date_of_birth: '1990-01-01', gender: 'male', height_cm: 180, weight_kg: 80 }
  );
  const tRow = await query(
    'SELECT COUNT(*)::int AS c FROM client_intake_profiles WHERE client_user_id = $1', [trainer.user.id]
  );
  assert.strictEqual(tRow.rows[0].c, 0, 'trainers do not get a body profile');

  const plain = await signup({ name: 'P', email: `sp_pl_${suffix}@test.local`, password: PASSWORD, role: 'user' });
  tokens[plain.user.email] = plain.accessToken;
  const pRow = await query(
    'SELECT COUNT(*)::int AS c FROM client_intake_profiles WHERE client_user_id = $1', [plain.user.id]
  );
  assert.strictEqual(pRow.rows[0].c, 0, 'no profile row without profile fields');
});

test('validation: bad DOB / gender / ranges rejected AND the user row is not created', async () => {
  const cases = [
    { profile: { date_of_birth: '15-03-1998' } },
    { profile: { date_of_birth: '2090-01-01' } },
    { profile: { gender: 'robot' } },
    { profile: { height_cm: 400 } },
    { profile: { weight_kg: 0 } },
  ];
  for (const [i, extra] of cases.entries()) {
    const email = `sp_bad_${i}_${suffix}@test.local`;
    const res = await api(null, 'POST', '/auth/signup',
      { name: 'Bad', email, password: PASSWORD, role: 'user', ...extra });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
    const row = await query('SELECT COUNT(*)::int AS c FROM users WHERE email = $1', [email]);
    assert.strictEqual(row.rows[0].c, 0, 'compensating delete removed the user row');
  }
});

test('health-profile form pre-populates from the seeded signup profile', async () => {
  const person = { name: 'Intake Pre', email: `sp_int_${suffix}@test.local`, password: PASSWORD, role: 'user' };
  const created = await signup(person, {
    date_of_birth: '1996-07-04', gender: 'male', height_cm: 175, weight_kg: 70,
  });
  tokens[person.email] = created.accessToken;
  const profile = await (await api(created.accessToken, 'GET', '/client/intake-profile')).json();
  assert.strictEqual(profile.date_of_birth, '1996-07-04');
  assert.strictEqual(profile.gender, 'male');
  assert.strictEqual(Number(profile.height_cm), 175);
  assert.strictEqual(Number(profile.weight_kg), 70);
});

// ── link-time backfill + portal visibility ───────────────────────────────

test('linking backfills the gym member\u2019s EMPTY profile fields from the app profile', async () => {
  const member = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Linked', email: `sp_link_${suffix}@test.local` })).json();
  // the linked app user ALSO signed up with a body profile
  const appSignup = await signup(
    { name: 'Link Profile', email: `sp_linkp_${suffix}@test.local`, password: PASSWORD, role: 'user' },
    { date_of_birth: '2000-11-20', gender: 'male', height_cm: 182, weight_kg: 78 }
  );
  tokens[appSignup.user.email] = appSignup.accessToken;

  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/link-app`, { email: `sp_linkp_${suffix}@test.local` });
  const linked = await link.json();
  assert.strictEqual(link.status, 200, `link: ${JSON.stringify(linked)}`);
  assert.strictEqual(linked.date_of_birth, '2000-11-20', 'DOB backfilled from the app profile');
  assert.strictEqual(linked.gender, 'male');
  assert.ok(linked.profile_backfilled, 'backfill reported');

  // desk-entered DOB is authoritative: pre-set DOB is never overwritten
  const member2 = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'DeskFirst', date_of_birth: '1980-01-01', email: `sp_df_${suffix}@test.local` })).json();
  await signup({ name: 'DF App', email: `sp_dfu_${suffix}@test.local`, password: PASSWORD, role: 'user' });
  await loginToken(`sp_dfu_${suffix}@test.local`);
  await api(tokens[`sp_dfu_${suffix}@test.local`], 'POST',
    `/gym/my/attendance/workout`).catch(() => {});
  const link2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member2.id}/link-app`, { email: `sp_dfu_${suffix}@test.local` });
  assert.strictEqual(link2.status, 200);
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member2.id}`)).json();
  assert.strictEqual(after.date_of_birth, '1980-01-01', 'desk-entered DOB kept');
});

test('already-linked members: app_profile overlay serves DOB/gender/height/weight read-only', async () => {
  // link an app user whose intake has the values, then clear the member's
  // columns to simulate a pre-existing link that predates the backfill
  const appSignup = await signup(
    { name: 'Overlay App', email: `sp_ov_${suffix}@test.local`, password: PASSWORD, role: 'user' },
    { date_of_birth: '1995-05-05', gender: 'other', height_cm: 170, weight_kg: 65 }
  );
  tokens[appSignup.user.email] = appSignup.accessToken;
  const member = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Overlay', email: `sp_ov_${suffix}@test.local` })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/link-app`, { email: `sp_ov_${suffix}@test.local` });
  await pool.query(
    `UPDATE gym_members SET date_of_birth = NULL, gender = NULL, profile = '{}' WHERE id = $1`,
    [member.id]
  );
  const detail = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}`)).json();
  assert.ok(detail.app_profile, 'overlay present');
  assert.strictEqual(detail.app_profile.date_of_birth, '1995-05-05');
  assert.strictEqual(detail.app_profile.gender, 'other');
  assert.strictEqual(Number(detail.app_profile.height_cm), 170);
  assert.strictEqual(Number(detail.app_profile.weight_kg), 65);
  // cross-gym: the overlay never leaks
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `SignupGym B ${suffix}` });
  const gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);
  const foreign = await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymB.id}/members/${member.id}`);
  assert.ok([403, 404].includes(foreign.status), `cross-gym blocked (${foreign.status})`);
});
