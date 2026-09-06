// Admin panel — platform gym-business features (F1 platform analytics,
// F2 gym management/lifecycle, F3 platform leads view). Real routers, real
// DB, self-cleaning fixtures, same harness conventions as admin.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('adminGymPlatform.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'admin-test-secret';

const { pool, query } = require('../src/db/pool');
const adminAuth = require('../src/admin/auth');
const adminModules = require('../src/admin/modules');
const adminGyms = require('../src/admin/gyms');
const gymRoutes = require('../src/routes/gym');

let app;
let server;
let baseUrl;

const suffix = crypto.randomBytes(4).toString('hex');
const ADMINS = {
  super_admin: { email: `gp_sa_${suffix}@test.local`, password: 'SuperPass1!' },
  analyst: { email: `gp_an_${suffix}@test.local`, password: 'AnalystPass1!' },
  read_only: { email: `gp_ro_${suffix}@test.local`, password: 'ReadOnly1!' },
};
const tokens = {};
const APP_USERS = [];

async function loginAs(role) {
  const res = await fetch(`${baseUrl}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMINS[role].email, password: ADMINS[role].password }),
  });
  assert.equal(res.status, 200, `login as ${role} should succeed`);
  const body = await res.json();
  return body.accessToken;
}

async function makeAppUser(email) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', 'App User', 'user') RETURNING id`,
    [email]
  );
  APP_USERS.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/admin', adminAuth.router);
  app.use('/admin', adminModules.router);
  app.use('/admin', adminGyms.router);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const [role, creds] of Object.entries(ADMINS)) {
    const hash = await bcrypt.hash(creds.password, 4);
    await query(
      `INSERT INTO admin_users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, is_active = true`,
      [creds.email, hash, role, role]
    );
    tokens[role] = await loginAs(role);
  }
});

after(async () => {
  await query(`DELETE FROM gym_leads WHERE gym_id IN (SELECT id FROM gyms WHERE name LIKE 'AdminGymTest ${suffix}%')`);
  await query(`DELETE FROM gyms WHERE name LIKE 'AdminGymTest ${suffix}%'`);
  await query(`DELETE FROM admin_audit_log WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_${suffix}@test.local')`);
  await query(`DELETE FROM admin_refresh_tokens WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_${suffix}@test.local')`);
  await query(`DELETE FROM admin_users WHERE email LIKE '%_${suffix}@test.local'`);
  for (const id of APP_USERS) await query('DELETE FROM users WHERE id = $1', [id]);
  if (server) server.close();
  await pool.end();
});

function adminApi(role, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens[role]}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── F1: platform analytics ───────────────────────────────────────────────

test('F1: platform analytics — every section present, real aggregates', async () => {
  const res = await adminApi('analyst', 'GET', '/admin/analytics/platform');
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of ['users', 'gyms', 'memberships', 'attendance', 'leads', 'trainers', 'gymTrend', 'leadTrend']) {
    assert.ok(body[key] !== undefined, `missing section ${key}`);
  }
  assert.ok(typeof body.users.total === 'number');
  assert.ok(typeof body.gyms.active === 'number');
  assert.ok(typeof body.leads.conversion_pct === 'number');
});

test('F1: platform analytics reflects new gyms and leads (delta check)', async () => {
  const before = await (await adminApi('analyst', 'GET', '/admin/analytics/platform')).json();
  await makeAppUser(`gp_delta_${suffix}@test.local`);
  await query(`INSERT INTO gyms (name, slug) VALUES ($1, $2)`,
    [`AdminGymTest ${suffix} delta`, `admingymtest-delta-${suffix}`]);
  const gymId = (await query(`SELECT id FROM gyms WHERE name = $1`, [`AdminGymTest ${suffix} delta`])).rows[0].id;
  await query(`INSERT INTO gym_leads (gym_id, full_name, phone) VALUES ($1, 'Delta Lead', '9000000099')`, [gymId]);

  const after = await (await adminApi('analyst', 'GET', '/admin/analytics/platform')).json();
  assert.equal(after.gyms.total, before.gyms.total + 1);
  assert.equal(after.leads.total, before.leads.total + 1);
});

test('F1: unauthenticated access is rejected', async () => {
  const res = await fetch(`${baseUrl}/admin/analytics/platform`);
  assert.equal(res.status, 401);
});

// ── F2: gym management + platform lifecycle ─────────────────────────────

let gymA2, gymB2, ownerA2;

test('F2 setup: two gyms with owners', async () => {
  ownerA2 = await makeAppUser(`gp_owner_${suffix}@test.local`);
  await query(`INSERT INTO gyms (name, slug) VALUES ($1, $2)`,
    [`AdminGymTest ${suffix} Alpha`, `admingymtest-alpha-${suffix}`]);
  gymA2 = (await query(`SELECT id FROM gyms WHERE slug = $1`, [`admingymtest-alpha-${suffix}`])).rows[0].id;
  await query(`INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1, $2, 'OWNER')`, [gymA2, ownerA2]);
  await query(`INSERT INTO gyms (name, slug) VALUES ($1, $2)`,
    [`AdminGymTest ${suffix} Beta`, `admingymtest-beta-${suffix}`]);
  gymB2 = (await query(`SELECT id FROM gyms WHERE slug = $1`, [`admingymtest-beta-${suffix}`])).rows[0].id;
});

test('F2: platform gym list — search by name, status filter, counts', async () => {
  const res = await adminApi('analyst', 'GET', `/admin/gyms?q=${encodeURIComponent('AdminGymTest ' + suffix)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.total >= 1);
  const gym = body.gyms.find((g) => g.slug === `admingymtest-alpha-${suffix}`);
  assert.ok(gym, 'alpha gym in list');
  assert.equal(gym.owner_email, `gp_owner_${suffix}@test.local`, 'owner resolved');
  // status filter
  const onlyActive = await (await adminApi('analyst', 'GET', '/admin/gyms?status=ACTIVE')).json();
  assert.ok(onlyActive.gyms.every((g) => g.status === 'ACTIVE'));
});

test('F2: gym detail — staff roster + counts', async () => {
  const res = await adminApi('analyst', 'GET', `/admin/gyms/${gymA2}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.gym.id, gymA2);
  assert.ok(body.staff.some((s) => s.gym_role === 'OWNER'));
  assert.ok(typeof body.counts.members === 'number');
  // unknown id → 404
  const missing = await adminApi('analyst', 'GET', `/admin/gyms/${crypto.randomUUID()}`);
  assert.equal(missing.status, 404);
});

test('F2: suspend requires super_admin', async () => {
  const res = await adminApi('analyst', 'PATCH', `/admin/gyms/${gymA2}/suspend`, { reason: 'not allowed' });
  assert.equal(res.status, 403);
});

test('F2: suspend → gym stops operating (guard chain) → reactivate restores', async () => {
  // owner suspends... no — ADMIN suspends; the portal guard must 403 immediately
  const res = await adminApi('super_admin', 'PATCH', `/admin/gyms/${gymA2}/suspend`,
    { reason: 'terms of service violation' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'SUSPENDED');

  // the gym's OWN owner now hits the suspended wall (same chain as the portal)
  const appRes = await fetch(`${baseUrl}/gym/${gymA2}/permissions`, {
    headers: { Authorization: `Bearer ${await appUserToken(ownerA2)}` },
  });
  const body = await appRes.json();
  assert.equal(appRes.status, 403, JSON.stringify(body));
  assert.strictEqual(body.error, 'This gym is suspended');

  // double suspend is a 404-shaped no-op (already suspended)
  const again = await adminApi('super_admin', 'PATCH', `/admin/gyms/${gymA2}/suspend`, { reason: 'again' });
  assert.equal(again.status, 404);

  // reactivate
  const re = await adminApi('super_admin', 'PATCH', `/admin/gyms/${gymA2}/reactivate`, {});
  assert.equal(re.status, 200);
  assert.equal((await re.json()).status, 'ACTIVE');
  const appRes2 = await fetch(`${baseUrl}/gym/${gymA2}/permissions`, {
    headers: { Authorization: `Bearer ${await appUserToken(ownerA2)}` },
  });
  assert.equal(appRes2.status, 200);
});

// small helper: mint an app JWT for an app user (uses the app auth secret)
async function appUserToken(userId) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

// ── F3: platform-wide leads view (read-only) ─────────────────────────────

test('F3: platform leads list — gym name joined, filters work, cross-gym visible', async () => {
  await query(`INSERT INTO gym_leads (gym_id, full_name, phone) VALUES ($1, 'Alpha Lead', '9888800001')`, [gymA2]);
  await query(`INSERT INTO gym_leads (gym_id, full_name, phone) VALUES ($1, 'Beta Lead', '9888800002')`, [gymB2]);

  const all = await (await adminApi('analyst', 'GET', '/admin/leads?limit=100')).json();
  assert.ok(all.total >= 2);
  const alpha = all.leads.find((l) => l.full_name === 'Alpha Lead');
  const beta = all.leads.find((l) => l.full_name === 'Beta Lead');
  assert.ok(alpha && beta, 'leads from both gyms visible platform-wide');
  assert.ok(alpha.gym_name.includes('Alpha'), 'gym name joined');

  const filtered = await (await adminApi('analyst', 'GET', `/admin/leads?gym_id=${gymB2}`)).json();
  assert.ok(filtered.leads.every((l) => l.gym_id === gymB2), 'gym filter narrows correctly');
  assert.ok(filtered.leads.some((l) => l.full_name === 'Beta Lead'));

  const byStatus = await (await adminApi('analyst', 'GET', '/admin/leads?status=NEW&limit=100')).json();
  assert.ok(byStatus.leads.every((l) => l.status === 'NEW'));
});

test('F3: unauthenticated leads access rejected', async () => {
  const res = await fetch(`${baseUrl}/admin/leads`);
  assert.equal(res.status, 401);
});
