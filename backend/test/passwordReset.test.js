// Password-reset flow tests — forgot-password + reset-password endpoints
// against the real database, with the email transport stubbed out.
// Run: node --test test/passwordReset.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('passwordReset.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query, transaction } = require('../src/db/pool');
const { _resetRateLimitsForTests } = require('../src/middleware/rateLimit');


let app;
let server;
let baseUrl;
let userId;
const suffix = crypto.randomBytes(4).toString('hex');
const EMAIL = `pwreset_${suffix}@test.local`;
const OLD_PASSWORD = 'OldPassword123';
let sentEmails = []; // captured by the fake provider

before(async () => {
  // inject a fake mailer BEFORE requiring the router
  sentEmails = [];
  const fake = {
    send: async (mail) => {
      sentEmails.push(mail); // keep full payload — token lives in html/text
      return { messageId: 'test-' + sentEmails.length };
    },
  };
  const provider = require('../src/email/provider');
  provider.setEmailProviderForTests(fake);

  const passwordResetRoutes = require('../src/routes/passwordReset');
  app = express();
  app.use(express.json());
  app.use('/auth', passwordResetRoutes);
  await new Promise((r) => (server = app.listen(0, r)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const hash = await bcrypt.hash(OLD_PASSWORD, 4);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,'PW Reset Test','user') RETURNING id`,
    [EMAIL, hash]
  );
  userId = rows[0].id;
});

after(async () => {
  await query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
  if (server) server.close();
  await pool.end();
});

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const freshLimits = () => _resetRateLimitsForTests();

async function requestReset(email) {
  const r = await post('/auth/forgot-password', { email });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['message']);
  assert.match(r.body.message, /If an account exists/);
}

// extract raw token from DB is impossible (hashed) — instead capture it by
// rebuilding what the route did? No: read it from the fake email URL.
function tokenFromLastEmail() {
  const urlMatch = sentEmails[sentEmails.length - 1]?.html?.match(/token=([a-f0-9]{64})/);
  return urlMatch ? urlMatch[1] : null;
}

// ── forgot-password ────────────────────────────────────────────────────
test('forgot: existing email returns generic success and sends email', async () => {
  sentEmails = [];
  freshLimits();
  await requestReset(EMAIL);
  assert.equal(sentEmails.length, 1);
  assert.ok(sentEmails[0].subject.includes('Reset'));
});

test('forgot: unknown email produces IDENTICAL response (enumeration guard)', async () => {
  sentEmails = [];
  freshLimits();
  const before1 = await post('/auth/forgot-password', { email: EMAIL });
  const unknown = await post('/auth/forgot-password', { email: `ghost_${suffix}@test.local` });
  assert.equal(before1.body.message, unknown.body.message);
  assert.equal(unknown.status, before1.status);
  // no additional email was actually sent for the ghost address
  assert.equal(sentEmails.length, 1);
});

test('forgot: uppercase + whitespace email is normalized', async () => {
  sentEmails = [];
  freshLimits();
  sentEmails = [];
  await requestReset(`  ${EMAIL.toUpperCase()}  `);
  assert.equal(sentEmails.length, 1); // matched the lowercased stored row
});

test('forgot: empty and invalid emails are rejected', async () => {
  sentEmails = [];
  freshLimits();
  const empty = await post('/auth/forgot-password', { email: '' });
  assert.equal(empty.status, 400);
  const invalid = await post('/auth/forgot-password', { email: 'not-an-email' });
  assert.equal(invalid.status, 400);
  const noAt = await post('/auth/forgot-password', { email: 'john@example' });
  assert.equal(noAt.status, 400);
});

test('forgot: new request invalidates previous outstanding tokens', async () => {
  sentEmails = [];
  freshLimits();
  sentEmails = [];
  await requestReset(EMAIL);
  const tokenA = tokenFromLastEmail();
  await requestReset(EMAIL);
  const tokenB = tokenFromLastEmail();
  assert.notEqual(tokenA, tokenB);

  const useB = await post('/auth/reset-password', { token: tokenB, password: 'NewPassword123' });
  assert.equal(useB.status, 200);
  const useA = await post('/auth/reset-password', { token: tokenA, password: 'Hacked12345' });
  assert.equal(useA.status, 400); // invalidated by the newer request

  // restore state for later tests
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
    await bcrypt.hash(OLD_PASSWORD, 4),
    userId,
  ]);
});

// ── reset-password ─────────────────────────────────────────────────────
async function freshToken() {
  sentEmails = [];
  await requestReset(EMAIL);
  return tokenFromLastEmail();
}

test('reset: valid token changes the password transactionally', async () => {
  freshLimits();
  const token = await freshToken();
  const r = await post('/auth/reset-password', { token, password: 'NewPassword123' });
  assert.equal(r.status, 200);

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  assert.ok(await bcrypt.compare('NewPassword123', rows[0].password_hash));
  // old password no longer matches
  assert.ok(!(await bcrypt.compare(OLD_PASSWORD, rows[0].password_hash)));
});

test('login works with new password after reset', async () => {
  freshLimits();
  // direct DB check of credential validity (login endpoint tested elsewhere)
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  assert.ok(await bcrypt.compare('NewPassword123', rows[0].password_hash));
});

test('reset: same token rejected on second use (single-use)', async () => {
  freshLimits();
  const token = await freshToken();
  const first = await post('/auth/reset-password', { token, password: 'NewPassword123' });
  assert.equal(first.status, 200);
  const second = await post('/auth/reset-password', { token, password: 'AnotherPass99' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already been used/);
});

test('reset: invalid/tampered/missing tokens rejected safely', async () => {
  freshLimits();
  const missing = await post('/auth/reset-password', { password: 'Whatever123' });
  assert.equal(missing.status, 400);
  const tampered = await post('/auth/reset-password', {
    token: 'f'.repeat(63) + 'e',
    password: 'Whatever123',
  });
  assert.equal(tampered.status, 400);
  const garbage = await post('/auth/reset-password', { token: 'abc', password: 'Whatever123' });
  assert.equal(garbage.status, 400);
});

test('reset: expired token rejected with expiry message', async () => {
  freshLimits();
  const raw = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() - interval '1 minute')`,
    [userId, crypto.createHash('sha256').update(raw).digest('hex')]
  );
  const r = await post('/auth/reset-password', { token: raw, password: 'Whatever123' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /expired/i);
});

test('reset: short password rejected', async () => {
  freshLimits();
  const token = await freshToken();
  const r = await post('/auth/reset-password', { token, password: 'short' });
  assert.equal(r.status, 400);
});

test('reset: revokes all refresh tokens for the user', async () => {
  freshLimits();
  // give the user an active refresh token, then reset
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, 'stale-refresh-token', now() + interval '7 days')`,
    [userId]
  );
  let { rows } = await query('SELECT count(*)::int c FROM refresh_tokens WHERE user_id = $1', [userId]);
  assert.ok(rows[0].c >= 1);
  const token = await freshToken();
  const r = await post('/auth/reset-password', { token, password: 'NewPassword123' });
  assert.equal(r.status, 200);
  ({ rows } = await query('SELECT count(*)::int c FROM refresh_tokens WHERE user_id = $1', [userId]));
  assert.equal(rows[0].c, 0);
});

test('forgot: rate limiting applies after repeated requests', async () => {
  freshLimits();
  sentEmails = [];
  // per-email limit is 3/hour — 4th request must be throttled
  for (let i = 0; i < 3; i++) {
    const ok = await post('/auth/forgot-password', { email: EMAIL });
    assert.equal(ok.status, 200);
  }
  const throttled = await post('/auth/forgot-password', { email: EMAIL });
  assert.equal(throttled.status, 429);
  assert.match(throttled.body.error, /Too many attempts/);
});
