// Admin Management section tests (global formulas, global exercises,
// unified user management). Run: node --test test/adminMgmt.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('adminMgmt.test.js requires DATABASE_URL');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');

let app;
let server;
let baseUrl;
let superToken, supportToken, analystToken;
let userAId, userBId;
const suffix = crypto.randomBytes(4).toString('hex');

before(async () => {
  const adminAuth = require('../src/admin/auth');
  const adminManagement = require('../src/admin/adminManagement');
  app = express();
  app.use(express.json());
  app.use('/admin', adminAuth.router);
  app.use('/admin', adminManagement.router);
  await new Promise((r) => (server = app.listen(0, r)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // admins: super_admin (writes) + analyst (no writes anywhere)
  const mkAdmin = async (email, password, role) => {
    const hash = await bcrypt.hash(password, 4);
    await query(
      `INSERT INTO admin_users (email, password_hash, name, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, is_active = true`,
      [email, hash, role, role]
    );
    const res = await fetch(`${baseUrl}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return (await res.json()).accessToken;
  };
  superToken = await mkAdmin(`mgmt_sa_${suffix}@test.local`, 'SuperPass1!', 'super_admin');
  analystToken = await mkAdmin(`mgmt_an_${suffix}@test.local`, 'AnalystP1!', 'analyst');

  // two regular users with distinct workouts
  for (const n of ['A', 'B']) {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1,$2,$3,'user') RETURNING id`,
      [`iso${n}_${suffix}@t.local`, 'x', `Iso${n}`]
    );
    if (n === 'A') userAId = rows[0].id; else userBId = rows[0].id;
  }
  await query(
    `INSERT INTO session_summaries (client_id, local_session_id, name, performed_at, duration_seconds, exercise_count, working_set_count, total_volume)
     VALUES ($1,'ls-a','UserA Workout', now(), 60, 1, 1, 100), ($2,'ls-b','UserB Workout', now(), 30, 1, 1, 200)`,
    [userAId, userBId]
  );
});

after(async () => {
  await query(`DELETE FROM session_summaries WHERE client_id IN ($1,$2)`, [userAId, userBId]);
  await query(`DELETE FROM users WHERE id IN ($1,$2)`, [userAId, userBId]);
  await query(`DELETE FROM progression_formula_globals WHERE updated_by IS NULL OR true AND formula_key LIKE '%test%'`);
  await query(`DELETE FROM admin_audit_log WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_mgmt_${suffix}@%')`);
  await query(`DELETE FROM admin_refresh_tokens WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_mgmt_${suffix}@%')`);
  await query(`DELETE FROM admin_users WHERE email LIKE '%_mgmt_${suffix}@%'`);
  if (createdExerciseId) await query('DELETE FROM exercises WHERE id = $1', [createdExerciseId]);
  if (server) server.close();
  await pool.end();
});

const api = (token) => async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const asSuper = () => api(superToken);
const asAnalyst = () => api(analystToken);

// ── Progression formulas ───────────────────────────────────────────────
test('formulas list returns all definitions with effective info', async () => {
  const r = await asSuper()('GET', '/admin/mgmt/formulas');
  assert.equal(r.status, 200);
  assert.ok(r.body.formulas.length >= 4);
  const lin = r.body.formulas.find((f) => f.key === 'linear_progression');
  assert.ok(lin.paramSchema.some((p) => p.key === 'incrementKg'));
});

test('super_admin sets global params → plain user resolves them', async () => {
  const put = await asSuper()('PUT', '/admin/mgmt/formulas/linear_progression/params', {
    params: { incrementKg: 6.5, requireAllSetsHit: true },
  });
  assert.equal(put.status, 200);
  // resolve through the real progression engine path
  const progression = require('../src/data/progression');
  const resolved = await progression.getResolved(userAId); // no settings row → default chain
  assert.equal(resolved.params.incrementKg, 6.5);
});

test('invalid and unknown params are rejected (no code injection possible)', async () => {
  const over = await asSuper()('PUT', '/admin/mgmt/formulas/linear_progression/params', {
    params: { incrementKg: 999 },
  });
  assert.equal(over.status, 400);
  const unknown = await asSuper()('PUT', '/admin/mgmt/formulas/linear_progression/params', {
    params: { evil: 'alert(1)' },
  });
  assert.equal(unknown.status, 400);
});

test('reset removes global override → back to schema defaults', async () => {
  const del = await asSuper()('DELETE', '/admin/mgmt/formulas/linear_progression/params');
  assert.equal(del.status, 200);
  const progression = require('../src/data/progression');
  const resolved = await progression.getResolved(userAId);
  assert.equal(resolved.params.incrementKg, 2.5); // schema default restored
});

// ── Exercise library ───────────────────────────────────────────────────
let createdExerciseId;
test('create global exercise works; duplicates rejected case-insensitively', async () => {
  const create = await asSuper()('POST', '/admin/mgmt/exercises', {
    name: `Test Zercher Squat ${suffix}`,
    body_part: 'legs',
    equipment: 'barbell',
  });
  assert.equal(create.status, 201);
  createdExerciseId = create.body.id;

  const dup = await asSuper()('POST', '/admin/mgmt/exercises', {
    name: `test zercher SQUAT ${suffix}`,
  });
  assert.equal(dup.status, 409);
});

test('edit updates metadata for everyone (same row)', async () => {
  const patch = await asSuper()('PATCH', `/admin/mgmt/exercises/${createdExerciseId}`, {
    muscle_group: 'quads',
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.muscle_group, 'quads');
});

test('usage counts reference by name without erroring', async () => {
  const r = await asSuper()('GET', `/admin/mgmt/exercises/${createdExerciseId}/usage`);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.usage.historical_session_records === 'number');
});

test('archive is SOFT (row remains, hidden from default list), restore works', async () => {
  const del = await asSuper()('DELETE', `/admin/mgmt/exercises/${createdExerciseId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.is_archived, true);

  const stillThere = await query('SELECT * FROM exercises WHERE id = $1', [createdExerciseId]);
  assert.equal(stillThere.rows.length, 1); // never hard-deleted

  const list = await asSuper()('GET', `/admin/mgmt/exercises?q=${encodeURIComponent('Test Zercher Squat ' + suffix)}`);
  assert.equal(list.body.total, 0); // hidden by default
  const archivedList = await asSuper()('GET', `/admin/mgmt/exercises?q=Test%20Zercher&archived=true`);
  assert.equal(archivedList.body.total, 1);

  const restore = await asSuper()('DELETE', `/admin/mgmt/exercises/${createdExerciseId}?restore=true`);
  assert.equal(restore.body.is_archived, false);
});

// ── Unified user management ────────────────────────────────────────────
test('user list supports server-side search and pagination', async () => {
  const search = await asSuper()('GET', `/admin/mgmt/users?q=IsoA_${suffix}`);
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 1);
  assert.equal(search.body.users[0].id, userAId);

  const paged = await asSuper()('GET', '/admin/mgmt/users?page=1&pageSize=1');
  assert.equal(paged.status, 200);
  assert.ok(paged.body.users.length <= 1);
});

test('overview counts are correct and scoped to the selected user', async () => {
  const a = await asSuper()('GET', `/admin/mgmt/users/${userAId}/overview`);
  assert.equal(a.status, 200);
  assert.equal(a.body.counts.workouts, 1);
  const b = await asSuper()('GET', `/admin/mgmt/users/${userBId}/overview`);
  assert.equal(b.body.counts.workouts, 1);
});

test('ISOLATION: user A view shows only A data; B only B (mandatory test)', async () => {
  const wa = await asSuper()('GET', `/admin/mgmt/users/${userAId}/workouts`);
  assert.equal(wa.body.items.length, 1);
  assert.equal(wa.body.items[0].name, 'UserA Workout');
  const wb = await asSuper()('GET', `/admin/mgmt/users/${userBId}/workouts`);
  assert.equal(wb.body.items.length, 1);
  assert.equal(wb.body.items[0].name, 'UserB Workout');
});

test('unknown user id → 404 across endpoints', async () => {
  const fake = '00000000-0000-0000-0000-000000000000';
  const o = await asSuper()('GET', `/admin/mgmt/users/${fake}/overview`);
  assert.equal(o.status, 404);
  const w = await asSuper()('GET', `/admin/mgmt/users/${fake}/workouts`);
  assert.equal(w.status, 404);
});

// ── Authorization ──────────────────────────────────────────────────────
test('RBAC: analyst cannot write formulas/exercises (server-side)', async () => {
  const fp = await asAnalyst()('PUT', '/admin/mgmt/formulas/linear_progression/params', {
    params: { incrementKg: 1 },
  });
  assert.equal(fp.status, 403);
  const ec = await asAnalyst()('POST', '/admin/mgmt/exercises', { name: 'Nope' });
  assert.equal(ec.status, 403);
  const ea = await asAnalyst()('DELETE', `/admin/mgmt/exercises/${createdExerciseId}`);
  assert.equal(ea.status, 403);
});

test('unauthenticated requests rejected on all mgmt surfaces', async () => {
  const anon = api(null);
  for (const p of ['/admin/mgmt/formulas', '/admin/mgmt/exercises', '/admin/mgmt/users']) {
    const r = await anon('GET', p);
    assert.equal(r.status, 401, `${p} must 401`);
  }
});
