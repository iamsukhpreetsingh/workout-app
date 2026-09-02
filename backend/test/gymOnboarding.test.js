// Gym owner onboarding & gym setup tests (Phase 2). Real routers mounted
// exactly as server.js mounts them, against the real DATABASE_URL, with
// self-cleaning fixtures.
//
// Covers the spec's edge cases: full-profile creation, duplicate names,
// invalid contact / hours / timezone / branding, atomic (transactional)
// creation, profile completion, logo upload/stream/remove, PATCH validation,
// owner leave (last-owner protection), deactivation → reactivation,
// multiple gyms per owner, and "creation never touches personal data".
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymOnboarding.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `onb_owner_${suffix}@test.local`, name: 'Onboard Owner' },
  coOwner: { email: `onb_co_${suffix}@test.local`, name: 'Co Owner' },
  desk: { email: `onb_desk_${suffix}@test.local`, name: 'Desk Person' },
  owner2: { email: `onb_owner2_${suffix}@test.local`, name: 'Multi Gym Owner' },
};
const tokens = {};
let gymC, gymD, gymD2; // C = full profile, D/D2 = minimal (same name)
const createdUserIds = [];
const createdGymIds = [];

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
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

const FULL_PROFILE = {
  name: `Onboard Gym C ${suffix}`,
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  website: 'https://onboardgymc.example.com',
  phone: '+91 98765 43210',
  email: `hello_${suffix}@onboardgymc.test`,
  address_line1: 'Sector 17', city: 'Chandigarh', state: 'Punjab', postal_code: '160017',
  operating_hours: {
    mon: { open: '05:00', close: '23:00' }, tue: { open: '05:00', close: '23:00' },
    wed: { open: '05:00', close: '23:00' }, thu: { open: '05:00', close: '23:00' },
    fri: { open: '05:00', close: '23:00' },
    sat: { open: '06:00', close: '22:00' }, sun: { open: '06:00', close: '22:00' },
  },
  branding: { primary_color: '#E8481F', secondary_color: '#1C1917' },
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

  // full-profile gym C by owner
  const resC = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', FULL_PROFILE);
  const bodyC = await resC.json();
  assert.strictEqual(resC.status, 201, `create gym C: ${JSON.stringify(bodyC)}`);
  gymC = bodyC.gym;
  createdGymIds.push(gymC.id);

  // two minimal gyms with the SAME name (duplicate-name edge case)
  for (const key of ['gymD', 'gymD2']) {
    const res = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym',
      { name: `Onboard Dup ${suffix}` });
    const body = await res.json();
    assert.strictEqual(res.status, 201, `create duplicate gym: ${JSON.stringify(body)}`);
    createdGymIds.push(body.gym.id);
    if (key === 'gymD') gymD = body.gym; else gymD2 = body.gym;
  }
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── creation ─────────────────────────────────────────────────────────────

test('full onboarding payload: normalized hours, branding, completion; creator is gym-scoped OWNER', async () => {
  assert.strictEqual(gymC.timezone, 'Asia/Kolkata');
  assert.strictEqual(gymC.website, 'https://onboardgymc.example.com');
  const hours = typeof gymC.operating_hours === 'string'
    ? JSON.parse(gymC.operating_hours) : gymC.operating_hours;
  assert.deepStrictEqual(hours.sat, { open: '06:00', close: '22:00' });
  const branding = typeof gymC.branding === 'string' ? JSON.parse(gymC.branding) : gymC.branding;
  assert.deepStrictEqual(branding, { primary_color: '#E8481F', secondary_color: '#1C1917' });

  const staff = await query(
    `SELECT gym_role, status FROM gym_staff WHERE gym_id = $1 AND user_id = (
       SELECT id FROM users WHERE email = $2)`,
    [gymC.id, PEOPLE.owner.email]
  );
  assert.strictEqual(staff.rows[0].gym_role, 'OWNER');
  assert.strictEqual(staff.rows[0].status, 'ACTIVE');

  // a plain app user upgrades to gym_staff globally (portal routing), but
  // ONLY the role column — nothing else about their account changes
  const user = await query('SELECT role FROM users WHERE email = $1', [PEOPLE.owner.email]);
  assert.strictEqual(user.rows[0].role, 'gym_staff');
});

test('creating a gym does not touch personal fitness data or other profile columns', async () => {
  // row-level check: the fixture user was created with these exact values
  const row = await query('SELECT name, email, created_at FROM users WHERE email = $1', [PEOPLE.owner.email]);
  assert.strictEqual(row.rows[0].name, PEOPLE.owner.name);
  assert.strictEqual(row.rows[0].email, PEOPLE.owner.email);
  // the mobile surface is unaffected: standalone endpoints still work for them
  const memberships = await (await api(tokens[PEOPLE.owner.email], 'GET', '/gym/my/memberships')).json();
  assert.deepStrictEqual(memberships, []);
});

test('duplicate gym names: both created, slugs unique', async () => {
  assert.strictEqual(gymD.name, gymD2.name);
  assert.notStrictEqual(gymD.slug, gymD2.slug);
});

// ── validation ───────────────────────────────────────────────────────────

test('invalid timezone rejected', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', '/gym',
    { name: 'TZ Gym', timezone: 'Mars/Olympus_Mons' });
  assert.strictEqual(res.status, 400);
});

test('invalid operating hours rejected (format, ordering, shape)', async () => {
  const cases = [
    { mon: { open: '5am', close: '23:00' } },   // not HH:MM
    { mon: { open: '20:00', close: '06:00' } }, // close before open
    { mon: { open: '23:99', close: '23:59' } }, // out-of-range minutes
    'not-an-object',
  ];
  for (const operating_hours of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', '/gym',
      { name: 'Hours Gym', operating_hours });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(operating_hours)}`);
  }
});

test('invalid contact information rejected (email, phone, website)', async () => {
  const cases = [
    { email: 'not-an-email' },
    { phone: 'call me maybe' },
    { website: 'javascript:alert(1)' },
    { website: 'not-a-url' },
  ];
  for (const extra of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'POST', '/gym',
      { name: 'Contact Gym', ...extra });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
  }
});

test('invalid branding colors rejected', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'POST', '/gym',
    { name: 'Brand Gym', branding: { primary_color: 'orange' } });
  assert.strictEqual(res.status, 400);
});

test('missing logo is fine — profile completion reports it, creation succeeds', async () => {
  const res = await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}`);
  const gym = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(gym.profile_completion.missing.includes('logo'));
  assert.ok(gym.profile_completion.percent < 100);
});

test('failed creation is atomic: a rejected create leaves zero rows behind', async () => {
  const beforeCount = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM gyms WHERE name = 'Atomic Gym') AS gyms,
       (SELECT COUNT(*)::int FROM gym_staff WHERE user_id = (SELECT id FROM users WHERE email = $1)) AS staff`,
    [PEOPLE.owner.email]
  );
  const bad = await api(tokens[PEOPLE.owner.email], 'POST', '/gym',
    { name: 'Atomic Gym', operating_hours: { mon: { open: 'x', close: 'y' } } });
  assert.strictEqual(bad.status, 400);
  const afterCount = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM gyms WHERE name = 'Atomic Gym') AS gyms,
       (SELECT COUNT(*)::int FROM gym_staff WHERE user_id = (SELECT id FROM users WHERE email = $1)) AS staff`,
    [PEOPLE.owner.email]
  );
  assert.deepStrictEqual(afterCount.rows[0], beforeCount.rows[0]);
});

// ── logo ─────────────────────────────────────────────────────────────────

test('logo upload: stores, streams back, completion updates, replace + delete', async () => {
  const up = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/logo`,
    { image_base64: TINY_PNG_BASE64, content_type: 'image/png' });
  const upBody = await up.json();
  assert.strictEqual(up.status, 201, `logo upload: ${JSON.stringify(upBody)}`);
  assert.ok(upBody.logo_key.startsWith(`${gymC.id}/`));

  const get = await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymC.id}/logo`);
  assert.strictEqual(get.status, 403, 'logo is gym-scoped: other gyms cannot read it');
  const mine = await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}/logo`);
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await mine.arrayBuffer());
  assert.ok(bytes.length > 0);

  const detail = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}`)).json();
  assert.strictEqual(detail.profile_completion.missing.includes('logo'), false);

  // replace with a new upload (old file must be removed, not leaked)
  const firstKey = detail.logo_key;
  const replace = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/logo`,
    { image_base64: `data:image/png;base64,${TINY_PNG_BASE64}` });
  assert.strictEqual(replace.status, 201);
  const detail2 = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}`)).json();
  assert.notStrictEqual(detail2.logo_key, firstKey);
  const firstPath = path.join(__dirname, '..', 'uploads', 'gym-logos', firstKey);
  assert.strictEqual(fs.existsSync(firstPath), false, 'replaced logo file must be deleted');

  const del = await api(tokens[PEOPLE.owner.email], 'DELETE', `/gym/${gymC.id}/logo`);
  assert.strictEqual(del.status, 200);
  const detail3 = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}`)).json();
  assert.strictEqual(detail3.logo_key, null);
});

test('logo upload rejects bad payloads (wrong type, oversized, garbage base64)', async () => {
  const wrongType = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/logo`,
    { image_base64: TINY_PNG_BASE64, content_type: 'application/pdf' });
  assert.strictEqual(wrongType.status, 400);

  const oversized = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/logo`,
    { image_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') });
  // 400 from our validator, or 413 if body-parser's limit trips first —
  // both mean "oversized logo rejected"
  assert.ok([400, 413].includes(oversized.status), `oversized status: ${oversized.status}`);

  const garbage = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/logo`,
    { image_base64: '@@@not-base64@@@' });
  assert.strictEqual(garbage.status, 400);
});

// ── PATCH validation ─────────────────────────────────────────────────────

test('PATCH updates onboarding fields; invalid values are rejected', async () => {
  // gymD belongs to owner2
  const ok = await api(tokens[PEOPLE.owner2.email], 'PATCH', `/gym/${gymD.id}`, {
    phone: '9876543210', email: `desk_${suffix}@dupgym.test`,
    website: 'https://dup.example.com', timezone: 'Asia/Kolkata',
    operating_hours: { mon: { open: '06:00', close: '22:00' } },
    branding: { primary_color: '#5856D6' },
  });
  assert.strictEqual(ok.status, 200);
  const gym = await ok.json();
  assert.deepStrictEqual(gym.operating_hours.sun, { closed: true }, 'omitted days normalize to closed');
  assert.deepStrictEqual(gym.branding, { primary_color: '#5856D6' });

  for (const bad of [
    { operating_hours: { mon: { open: '25:00', close: '26:00' } } },
    { branding: { primary_color: 'red' } },
    { email: 'nope' },
    { timezone: 'Nowhere/Nothing' },
    { website: 'ftp://files.example.com' },
  ]) {
    const res = await api(tokens[PEOPLE.owner2.email], 'PATCH', `/gym/${gymD.id}`, bad);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

// ── owner leave ──────────────────────────────────────────────────────────

test('sole owner cannot leave; after ownership transfer they can', async () => {
  const blocked = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/leave`);
  assert.strictEqual(blocked.status, 400, `sole owner leave: ${JSON.stringify(await blocked.json())}`);

  // co-owner added (owner must exist to grant it)
  const add = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/staff`,
    { email: PEOPLE.coOwner.email, gym_role: 'OWNER' });
  assert.strictEqual(add.status, 201);

  // desk also joins so the deactivate tests have a non-owner staff member
  const addDesk = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(addDesk.status, 201);

  const leave = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymC.id}/leave`);
  assert.strictEqual(leave.status, 200, `leave: ${JSON.stringify(await leave.json())}`);
  assert.strictEqual((await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymC.id}`)).status, 403);

  // co-owner now runs the gym
  assert.strictEqual((await api(tokens[PEOPLE.coOwner.email], 'GET', `/gym/${gymC.id}`)).status, 200);
  const staff = await (await api(tokens[PEOPLE.coOwner.email], 'GET', `/gym/${gymC.id}/staff`)).json();
  assert.strictEqual(staff.filter((s) => s.gym_role === 'OWNER' && s.status === 'ACTIVE').length, 1);

  const audit = await (await api(tokens[PEOPLE.coOwner.email], 'GET', `/gym/${gymC.id}/audit-log`)).json();
  assert.ok(audit.some((r) => r.action === 'staff.left'), 'staff.left audited');
});

test('non-owner staff can leave freely', async () => {
  const leave = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymC.id}/leave`);
  assert.strictEqual(leave.status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymC.id}`)).status, 403);
  // re-join for the deactivate tests
  const readd = await api(tokens[PEOPLE.coOwner.email], 'POST', `/gym/${gymC.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(readd.status, 201);
});

// ── deactivate / reactivate ──────────────────────────────────────────────

test('deactivation locks everyone out; reactivation is owner-only and restores access', async () => {
  const deact = await api(tokens[PEOPLE.coOwner.email], 'POST', `/gym/${gymC.id}/deactivate`);
  assert.strictEqual(deact.status, 200);
  assert.strictEqual((await deact.json()).status, 'INACTIVE');

  // all gym-context routes now fail for staff...
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymC.id}`)).status, 403);
  // ...including the (former) owner
  assert.strictEqual((await api(tokens[PEOPLE.coOwner.email], 'GET', `/gym/${gymC.id}`)).status, 403);

  // but the portal can still SEE it in /gym/mine with its status (reactivation UI)
  const mine = await (await api(tokens[PEOPLE.coOwner.email], 'GET', '/gym/mine')).json();
  const entry = mine.find((g) => g.id === gymC.id);
  assert.ok(entry, 'deactivated gym stays listed for its staff');
  assert.strictEqual(entry.gym_status, 'INACTIVE');

  // non-owner cannot reactivate; owner can
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymC.id}/reactivate`)).status, 403);
  const react = await api(tokens[PEOPLE.coOwner.email], 'POST', `/gym/${gymC.id}/reactivate`);
  assert.strictEqual(react.status, 200, `reactivate: ${JSON.stringify(await react.json())}`);
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET', `/gym/${gymC.id}`)).status, 200);

  const audit = await (await api(tokens[PEOPLE.coOwner.email], 'GET', `/gym/${gymC.id}/audit-log`)).json();
  for (const expected of ['gym.deactivated', 'gym.reactivated']) {
    assert.ok(audit.some((r) => r.action === expected), `audit missing ${expected}`);
  }
});

test('platform-suspended gym cannot self-reactivate', async () => {
  await pool.query(`UPDATE gyms SET status = 'SUSPENDED' WHERE id = $1`, [gymD.id]);
  const res = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymD.id}/reactivate`);
  assert.strictEqual(res.status, 403);
  await pool.query(`UPDATE gyms SET status = 'ACTIVE' WHERE id = $1`, [gymD.id]);
});

// ── multiple gyms ────────────────────────────────────────────────────────

test('multiple gyms: one owner, several gyms, each with its own context', async () => {
  const mine = await (await api(tokens[PEOPLE.owner2.email], 'GET', '/gym/mine')).json();
  assert.strictEqual(mine.length, 2);
  assert.ok(mine.every((g) => g.gym_role === 'OWNER' && g.gym_status === 'ACTIVE'));
  const one = await (await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymD2.id}`)).json();
  assert.strictEqual(one.id, gymD2.id);
});

test('audit trail records the onboarding lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.coOwner.email],
    'GET', `/gym/${gymC.id}/audit-log?limit=200`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['gym.created', 'gym.logo_updated', 'gym.logo_removed', 'staff.left', 'gym.deactivated', 'gym.reactivated']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
