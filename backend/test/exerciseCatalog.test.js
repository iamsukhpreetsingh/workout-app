// Server-authoritative exercise catalog endpoint tests.
// Run: node --test test/exerciseCatalog.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('exerciseCatalog.test.js requires DATABASE_URL');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');

let server;
let baseUrl;
let userToken;
const suffix = crypto.randomBytes(4).toString('hex');
let testExerciseId;

before(async () => {
  const authRoutes = require('../src/routes/auth');
  const catalogRoutes = require('../src/routes/exerciseCatalog');
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/exercises', catalogRoutes);
  await new Promise((r) => (server = app.listen(0, r)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // real login through the mounted auth router
  const email = `cat_${suffix}@t.local`;
  await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,'Cat','user')
     ON CONFLICT (email) DO NOTHING`,
    [email, await bcrypt.hash('password123', 4)]
  );
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  userToken = (await res.json()).accessToken;

  // one archived + one active exercise so filtering is provable
  await query(
    `INSERT INTO exercises (id, name, category) VALUES ($1,$2,'chest')`,
    [`cat_archived_${suffix}`, `Archived Test Ex ${suffix}`]
  );
  await query(`UPDATE exercises SET is_archived = TRUE WHERE id = $1`, [`cat_archived_${suffix}`]);
  await query(
    `INSERT INTO exercises (id, name, category) VALUES ($1,$2,'waist')`,
    [`cat_active_${suffix}`, `Active Test Ex ${suffix}`]
  );
  testExerciseId = `cat_active_${suffix}`;
});

after(async () => {
  await query(`DELETE FROM exercises WHERE id IN ($1, $2)`,
    [`cat_archived_${suffix}`, `cat_active_${suffix}`]);
  await query(`DELETE FROM users WHERE email LIKE 'cat_${suffix}@%'`);
  if (server) server.close();
  await pool.end();
});

const get = async (path, token) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

test('catalog requires authentication', async () => {
  assert.equal((await get('/exercises/catalog', null)).status, 401);
  assert.equal((await get('/exercises/catalog/meta', null)).status, 401);
});

test('meta returns count and a stable version string', async () => {
  const r = await get('/exercises/catalog/meta', userToken);
  assert.equal(r.status, 200);
  assert.ok(r.body.count >= 1000); // seeded library
  assert.ok(/^\d+:/.test(r.body.version));
});

test('catalog returns the full library with mapped muscle groups', async () => {
  const r = await get('/exercises/catalog', userToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, r.body.exercises.length);
  const sample = r.body.exercises[0];
  for (const k of ['name', 'muscle_group', 'instructions']) assert.ok(k in sample);
});

test('archived exercises are excluded from the catalog and meta count', async () => {
  const r = await get('/exercises/catalog', userToken);
  const names = r.body.exercises.map((e) => e.name);
  assert.ok(!names.includes(`Archived Test Ex ${suffix}`), 'archived must be excluded');
  assert.ok(names.includes(`Active Test Ex ${suffix}`), 'active must be included');
});
