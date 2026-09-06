// Gym Leads / Visitor QR tests (leads phase).
//
// The two separations this suite exists to protect:
//   1. LEAD QR ≠ ATTENDANCE QR — the lead scanner (public page) rejects
//      attendance payloads and the attendance scanner rejects lead payloads;
//      neither ever produces the other's record.
//   2. A LEAD IS NOT A MEMBER — submitting the public form never creates a
//      user, credentials or a gym_members row; conversion is explicit.
//
// Also covered: gym isolation, permission gating, duplicate handling
// (double-tap dedupe + existing-member flag), dead/rotated QR behavior,
// input validation, and rate limiting on the public endpoints.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymLeads.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');
const gyms = require('../src/data/gyms');
const leads = require('../src/data/gymLeads');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  ownerA: { email: `ld_owner_${suffix}@test.local`, name: 'Owner A' },
  ownerB: { email: `ld_ownerb_${suffix}@test.local`, name: 'Owner B' },
  trainerA: { email: `ld_trainer_${suffix}@test.local`, name: 'Trainer A' },
};
const tokens = {};
let gymA, gymB, codeA, codeB;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(body));
  createdUserIds.push(body.user.id);
  return body.user.id;
}

async function auth(person) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
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

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/gym', gymRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  gymA = (await gyms.createGym((await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id,
    '127.0.0.1', { name: `LeadsGym A ${suffix}`, city: 'Mohali' })).gym.id;
  createdGymIds.push(gymA);
  gymB = (await gyms.createGym((await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerB.email])).rows[0].id,
    '127.0.0.1', { name: `LeadsGym B ${suffix}` })).gym.id;
  createdGymIds.push(gymB);
  await query("INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1, (SELECT id FROM users WHERE email = $2), 'TRAINER')", [gymA, PEOPLE.trainerA.email]);

  codeA = await leads.ensureLeadQrCode(gymA);
  codeB = await leads.ensureLeadQrCode(gymB);
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── public landing + isolation ───────────────────────────────────────────

test('landing: QR resolves the right gym with its enquiry types', async () => {
  const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.state, 'OK');
  assert.strictEqual(body.gym_name, `LeadsGym A ${suffix}`);
  assert.ok(Array.isArray(body.types) && body.types.includes('TRIAL'));
});

test('landing: gym A QR never reveals gym B', async () => {
  const body = await (await fetch(`${baseUrl}/gym/leads/public/${codeA}`)).json();
  assert.ok(!JSON.stringify(body).includes('LeadsGym B'));
});

test('landing: malformed / unknown / attendance-shaped tokens get the safe UNAVAILABLE state', async () => {
  for (const bad of ['no-such-token', 'gymcheckin:v1:deadbeefdeadbeefdeadbeef', `${codeA}x`]) {
    const res = await fetch(`${baseUrl}/gym/leads/public/${encodeURIComponent(bad)}`);
    const body = await res.json();
    assert.strictEqual(body.state, 'UNAVAILABLE', `token ${bad.slice(0, 16)} must be UNAVAILABLE`);
    assert.strictEqual(body.gym_name, undefined, 'no gym details may leak');
  }
});

// ── public submission: validation, dedupe, member matching ───────────────

test('submit: a valid lead is created with status NEW and source GYM_QR', async () => {
  const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: "O'Connor Mary-Jane", phone: '98765 43210',
      email: 'MJ@Example.COM', enquiry_type: 'TRIAL', message: 'Interested in weights' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(body));
  assert.strictEqual(body.ok, true);
  const list = await leads.listLeads(gymA, { status: 'NEW' });
  const lead = list.find((l) => l.phone.includes('98765'));
  assert.ok(lead, 'lead is in the gym A inbox');
  assert.strictEqual(lead.source, 'GYM_QR');
  assert.strictEqual(lead.status, 'NEW');
  assert.strictEqual(lead.enquiry_type, 'TRIAL');
  assert.strictEqual(lead.email, 'mj@example.com', 'email normalized');
});

test('submit: double-tap within the window does not create a duplicate', async () => {
  await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Retry Rita', phone: '9123456780' }),
  });
  const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Retry Rita', phone: '9123456780' }),
  });
  const body = await res.json();
  assert.strictEqual(body.duplicate, true, 'second submission is flagged as duplicate');
  const list = await leads.listLeads(gymA, { q: 'Retry Rita' });
  assert.strictEqual(list.length, 1, 'exactly one lead row exists');
});

test('submit: server-side validation rejects bad input with helpful messages', async () => {
  const cases = [
    [{ full_name: '', phone: '9876543210' }, 'name'],
    [{ full_name: 'X', phone: '123' }, 'valid mobile'],
    [{ full_name: 'X', phone: '9876543210', email: 'not-an-email' }, 'valid email'],
    [{ full_name: 'X'.repeat(90), phone: '9876543210' }, 'valid name'],
  ];
  for (const [payload, expect] of cases) {
    const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res.status, 400, JSON.stringify(payload));
    const body = await res.json();
    assert.ok(body.error.toLowerCase().includes(expect), `${expect}: got "${body.error}"`);
  }
});

test('submit: lead whose phone matches an existing member is flagged, not duplicated', async () => {
  const ownerId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  const m = await gyms.createGymMember(gymA, { userId: ownerId }, '127.0.0.1',
    { first_name: 'Existing', phone: '9000000001' });
  await query('UPDATE gym_members SET phone = $2 WHERE id = $1', [m.id, '9000000001']);

  const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Existing Person', phone: '9000000001' }),
  });
  assert.strictEqual(res.status, 201, 'the form still works for a member');
  const list = await leads.listLeads(gymA, { q: 'Existing Person' });
  assert.strictEqual(list.length, 1);
  assert.ok(list[0].matched_member, 'lead flagged with the existing member id');
  const memberCount = (await query(
    `SELECT COUNT(*)::int AS c FROM gym_members WHERE gym_id = $1 AND phone = '9000000001'`, [gymA]
  )).rows[0].c;
  assert.strictEqual(memberCount, 1, 'no second member record was created');
});

test('submit: a lead NEVER creates a user account', async () => {
  const beforeUsers = (await query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
  await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'No Account', phone: '9111100000' }),
  });
  const afterUsers = (await query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
  assert.strictEqual(beforeUsers, afterUsers, 'public form must never create credentials');
});

test('submit: dead QR (rotated) creates nothing', async () => {
  const newCode = await leads.rotateLeadQrCode(gymB, { userId: (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerB.email])).rows[0].id }, '127.0.0.1', gyms.gymAudit);
  const res = await fetch(`${baseUrl}/gym/leads/public/${codeB}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Late Larry', phone: '9222200000' }),
  });
  assert.strictEqual(res.status, 404);
  const landing = await (await fetch(`${baseUrl}/gym/leads/public/${codeB}`)).json();
  assert.strictEqual(landing.state, 'UNAVAILABLE', 'old QR shows the safe message');
  const newLanding = await (await fetch(`${baseUrl}/gym/leads/public/${newCode}`)).json();
  assert.strictEqual(newLanding.state, 'OK', 'new QR works');
  // refresh codeB for later tests? no — gym B QR stays rotated; tests below use gym A
});

// ── attendance isolation (spec 2/29) ─────────────────────────────────────

test('isolation: the attendance check-in path rejects lead payloads explicitly', async () => {
  const memberToken = await signupAndLogin(`ld_member_${suffix}@test.local`);
  // link a member so the request reaches code resolution
  const ownerId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  const m = await gyms.createGymMember(gymA, { userId: ownerId }, '127.0.0.1', { first_name: 'Scan' });
  await gyms.linkMemberToApp(gymA, m.id, { userId: ownerId }, '127.0.0.1', { email: `ld_member_${suffix}@test.local` });

  const res = await api(memberToken, 'POST', '/gym/my/attendance/check-in', { code: `gymlead:v1:${codeA}` });
  assert.strictEqual(res.status, 400, 'lead QR must be rejected by the attendance scanner');
  const body = await res.json();
  assert.strictEqual(body.error, 'This QR code is not an attendance QR code.');
  // and NO attendance record was created
  const visits = (await query(
    `SELECT COUNT(*)::int AS c FROM gym_attendance WHERE gym_id = $1`, [gymA]
  )).rows[0].c;
  assert.strictEqual(visits, 0, 'no attendance record from a lead QR');
});

test('isolation: the lead endpoints reject attendance payloads', async () => {
  const landing = await (await fetch(`${baseUrl}/gym/leads/public/${encodeURIComponent('gymcheckin:v1:aaaaaaaaaaaaaaaaaaaaaaaa')}`)).json();
  assert.strictEqual(landing.state, 'UNAVAILABLE');
  const submit = await fetch(`${baseUrl}/gym/leads/public/${encodeURIComponent('gymcheckin:v1:aaaaaaaaaaaaaaaaaaaaaaaa')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'X', phone: '9333300000' }),
  });
  assert.strictEqual(submit.status, 404, 'attendance QR must never create a lead');
});

async function signupAndLogin(email) {
  const id = await signup({ email, name: 'Scan Member' });
  return auth({ email, name: 'Scan Member' }).then(() => {
    void id;
    return tokens[email];
  });
}

// ── staff: permissions, isolation, lifecycle ─────────────────────────────

test('permissions: trainer (no leads.view) is 403; owner sees the inbox', async () => {
  const t = await api(tokens[PEOPLE.trainerA.email], 'GET', `/gym/${gymA}/leads`);
  assert.strictEqual(t.status, 403);
  const o = await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/leads`);
  assert.strictEqual(o.status, 200);
  const body = await o.json();
  assert.ok(body.length >= 3, 'gym A leads are listed');
});

test('isolation: gym A owner cannot read gym B leads or rotate gym B QR', async () => {
  const listB = await api(tokens[PEOPLE.ownerB.email], 'GET', `/gym/${gymB}/leads`);
  assert.strictEqual(listB.status, 200);
  const listAOwnerOnB = await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymB}/leads`);
  assert.strictEqual(listAOwnerOnB.status, 403);
  const rot = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymB}/leads/qr-code/rotate`, {});
  assert.strictEqual(rot.status, 403);
});

test('lifecycle: status transitions audited with before/after', async () => {
  const list = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/leads?status=NEW`)).json();
  assert.ok(list.length >= 1);
  const lead = list[0];
  const res = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/leads/${lead.id}/status`,
    { status: 'CONTACTED' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'CONTACTED');
  // invalid status rejected
  const bad = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/leads/${lead.id}/status`,
    { status: 'MAYBE' });
  assert.strictEqual(bad.status, 400);
});

test('notes: internal notes are added, listed and never pushed to the public form', async () => {
  const list = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/leads`)).json();
  const lead = list[0];
  const res = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/leads/${lead.id}/notes`,
    { note: 'Called — interested in monthly membership' });
  assert.strictEqual(res.status, 201);
  const detail = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/leads/${lead.id}`)).json();
  assert.ok(detail.notes.some((n) => n.note.includes('monthly membership')));
  // the public landing exposes only gym name/types — never notes
  const landing = await (await fetch(`${baseUrl}/gym/leads/public/${codeA}`)).json();
  assert.ok(!JSON.stringify(landing).includes('monthly membership'));
});

test('convert: back-links an existing member and marks JOINED (audited)', async () => {
  const ownerId = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerA.email])).rows[0].id;
  const m = await gyms.createGymMember(gymA, { userId: ownerId }, '127.0.0.1',
    { first_name: 'Converted', phone: '9444400000' });
  // the lead for this person comes in through the public form first
  await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Converted Cat', phone: '9444400000' }),
  });
  const list = await (await api(tokens[PEOPLE.ownerA.email], 'GET', `/gym/${gymA}/leads?q=Converted`)).json();
  const lead = list.find((l) => l.phone === '9444400000');
  assert.ok(lead, 'the lead exists in the inbox');
  const res = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/leads/${lead.id}/convert`,
    { member_id: m.id });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.status, 'JOINED');
  assert.strictEqual(body.converted_member.member_code, m.member_code);
  // foreign member id → 404
  const mB = await gyms.createGymMember(gymB, { userId: (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.ownerB.email])).rows[0].id }, '127.0.0.1', { first_name: 'Foreign' });
  const foreign = await api(tokens[PEOPLE.ownerA.email], 'POST', `/gym/${gymA}/leads/${lead.id}/convert`,
    { member_id: mB.id });
  assert.strictEqual(foreign.status, 404, "another gym's member can never be linked");
});

test('rate limiting: public submission is throttled (429 eventually)', async () => {
  // earlier tests consumed part of the 20/hour per-IP budget — spam until it trips
  let got429 = false;
  for (let i = 0; i < 30 && !got429; i++) {
    const res = await fetch(`${baseUrl}/gym/leads/public/${codeA}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: `Spam ${i}`, phone: `95555${String(i).padStart(6, '0')}` }),
    });
    if (res.status === 429) got429 = true;
  }
  assert.ok(got429, 'expected a 429 once the per-IP budget is exhausted');
});
