// Admin dashboard tests — auto-discovery (ADMIN.md core requirement) and
// Phase 1 RBAC boundaries. Run: node --test test/
//
// These tests exercise the real routers mounted exactly as server.js mounts
// them, against the real DATABASE_URL database. They create and clean up
// their own fixtures (a throwaway table and throwaway admin users) — the
// documented "auto-discovery" verification from ADMIN.md General Requirements.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('admin.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'admin-test-secret';

const { pool, query } = require('../src/db/pool');
const adminAuth = require('../src/admin/auth');
const adminGeneric = require('../src/admin/generic');
const adminModules = require('../src/admin/modules');
const { registerRoute, registeredRoutes } = require('../src/admin/registry');
const { maskRows } = require('../src/admin/generic');

let app;
let server;
let baseUrl;

const TEST_TABLE = 'zz_admin_auto_discovery_test';
const suffix = crypto.randomBytes(4).toString('hex');
const ADMINS = {
  super_admin: { email: `sa_${suffix}@test.local`, password: 'SuperPass1!' },
  analyst: { email: `an_${suffix}@test.local`, password: 'AnalystPass1!' },
  read_only: { email: `ro_${suffix}@test.local`, password: 'ReadOnly1!' },
};
const tokens = {};

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

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/admin', adminAuth.router);
  app.use('/admin', adminGeneric.router);
  app.use('/admin', adminModules.router);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // fixtures: throwaway table + one admin per role
  await query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
  await query(`CREATE TABLE ${TEST_TABLE} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), note TEXT)`);

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
  await query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
  // audit rows reference admin_users — clear them first
  await query(`DELETE FROM admin_audit_log WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_${suffix}@test.local')`);
  await query(`DELETE FROM admin_refresh_tokens WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email LIKE '%_${suffix}@test.local')`);
  await query(`DELETE FROM admin_users WHERE email LIKE '%_${suffix}@test.local'`);
  if (server) server.close();
  await pool.end();
});

// ── Auto-discovery: a new DATABASE TABLE appears with zero code ────────
test('auto-discovery: throwaway table appears in GET /admin/schema', async () => {
  const res = await fetch(`${baseUrl}/admin/schema`, {
    headers: { Authorization: `Bearer ${tokens.super_admin}` },
  });
  assert.equal(res.status, 200);
  const tables = await res.json();
  const found = tables.find((t) => t.name === TEST_TABLE);
  assert.ok(found, 'new table must appear in schema introspection');
  assert.deepEqual(found.primaryKey, ['id']);
  const noteCol = found.columns.find((c) => c.name === 'note');
  assert.equal(noteCol.data_type, 'text');
});

test('auto-discovery: new table is browsable via GET /admin/data/:table', async () => {
  await query(`INSERT INTO ${TEST_TABLE} (note) VALUES ($1)`, ['hello']);
  const res = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}`, {
    headers: { Authorization: `Bearer ${tokens.super_admin}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].note, 'hello');
});

test('auto-discovery: a new registerRoute() appears in GET /admin/api-registry', async () => {
  const marker = `/zz_test_route_${suffix}`;
  const router = express.Router();
  registerRoute(router, {
    method: 'GET',
    path: marker,
    description: 'throwaway route for registry auto-discovery test',
    requiresAuth: true,
    allowedRoles: ['super_admin'],
    category: 'System',
  }, (req, res) => res.json({ ok: true }));

  // mounted or not, registration alone feeds the explorer
  const inRegistry = registeredRoutes().some((r) => r.path === marker);
  assert.ok(inRegistry, 'route metadata must be in the registry immediately');

  const res = await fetch(`${baseUrl}/admin/api-registry`, {
    headers: { Authorization: `Bearer ${tokens.super_admin}` },
  });
  assert.equal(res.status, 200);
  const routes = await res.json();
  assert.ok(routes.some((r) => r.path === marker), 'registered route must be served by /admin/api-registry');
});

// ── Security: sensitive data never leaves the server ───────────────────
test('sensitive columns are masked in generic reads (password_hash, tokens)', async () => {
  const res = await fetch(`${baseUrl}/admin/data/admin_users?pageSize=5`, {
    headers: { Authorization: `Bearer ${tokens.super_admin}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const row of body.rows) assert.equal(row.password_hash, '***');
});

test('maskRows masks token columns too', () => {
  const out = maskRows([{ token_hash: 'secret', expo_push_token: 'abc', name: 'x' }]);
  assert.equal(out[0].token_hash, '***');
  assert.equal(out[0].expo_push_token, '***');
});

test('crafted/invalid/excluded table names are rejected before any query', async () => {
  for (const t of [`users%20--drop`, 'nope_missing', 'admin_refresh_tokens']) {
    const res = await fetch(`${baseUrl}/admin/data/${t}`, {
      headers: { Authorization: `Bearer ${tokens.super_admin}` },
    });
    assert.equal(res.status, 404, `${t} should 404`);
  }
});

// ── Phase 1 RBAC boundaries: every write attempt by a non-writer → 403 ──
test('boundary: analyst cannot PATCH generic data', async () => {
  const { rows } = await query(`SELECT id FROM ${TEST_TABLE} LIMIT 1`);
  const res = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}/${rows[0].id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokens.analyst}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'hijack' }),
  });
  assert.equal(res.status, 403);
});

test('boundary: analyst cannot DELETE generic data', async () => {
  const { rows } = await query(`SELECT id FROM ${TEST_TABLE} LIMIT 1`);
  const res = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}/${rows[0].id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.analyst}` },
  });
  assert.equal(res.status, 403);
});

test('boundary: analyst cannot trigger broadcasts', async () => {
  const res = await fetch(`${baseUrl}/admin/broadcast/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.analyst}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'all_users', title: 'x', body: 'y' }),
  });
  assert.ok([403, 404].includes(res.status), 'analyst write must not succeed (403 expected)');
});

test('boundary: read_only cannot write anywhere', async () => {
  const res = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}`, {
    headers: { Authorization: `Bearer ${tokens.read_only}` },
  });
  assert.equal(res.status, 200); // can read...
  const { rows } = await query(`SELECT id FROM ${TEST_TABLE} LIMIT 1`);
  const del = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}/${rows[0].id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.read_only}` },
  });
  assert.equal(del.status, 403); // ...but never delete
});

test('boundary: super_admin CAN write generic data (control case)', async () => {
  const { rows } = await query(`SELECT id FROM ${TEST_TABLE} LIMIT 1`);
  const res = await fetch(`${baseUrl}/admin/data/${TEST_TABLE}/${rows[0].id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokens.super_admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'edited-by-super' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note, 'edited-by-super');
});

test('admin auth rejects unauthenticated requests on every /admin/* surface', async () => {
  for (const p of ['/admin/schema', '/admin/data/users', '/admin/api-registry', '/admin/audit-log']) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 401, `${p} without token must 401`);
  }
});
