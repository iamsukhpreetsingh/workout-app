// Multi-branch gym management tests (Phase 16). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec edge cases end-to-end:
//   branch CRUD + permissions · branch transfer (+ history) · branch
//   closure blocks NEW check-ins, history preserved · staff branch
//   changes (Front Desk → Mohali only) · trainer multiple branches
//   (overlap rule) · member multiple branches ({primary} ∪ allowed) ·
//   branch-specific plans (assignment guard) · branch-specific
//   attendance (branch-tagged rows) · cross-branch QR (QR works at any
//   allowed branch, rejected at closed / not-allowed ones) · historical
//   data (transfer keeps old attendance rows; label sync keeps Phase 14
//   audiences working) · dashboard [All Branches ▼] scoping.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymBranches.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `br_owner_${suffix}@test.local`, name: 'Branch Owner' },
  owner2: { email: `br_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `br_admin_${suffix}@test.local`, name: 'Branch Admin' },
  deskMohali: { email: `br_desk_${suffix}@test.local`, name: 'Desk Mohali' },
  trainerMohali: { email: `br_trainer_${suffix}@test.local`, name: 'Trainer Mohali' },
  trainerAny: { email: `br_trainer2_${suffix}@test.local`, name: 'Trainer Any' },
  mApp: { email: `br_member_${suffix}@test.local`, name: 'Member App' },
};
const tokens = {};
let gym, gymB, chd, mohali, delhi, planId;
const createdUserIds = [];
const createdGymIds = [];
let legacyMember, chdMember, mohaliMember, cancelledMember;

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
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  tokens[person.email] = (await res.json()).accessToken;
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

const owner = () => tokens[PEOPLE.owner.email];

async function createMember(payload) {
  const res = await api(owner(), 'POST', `/gym/${gym.id}/members`, payload);
  const body = await res.json();
  assert.strictEqual(res.status, 201, `member create: ${res.status}: ${JSON.stringify(body)}`);
  return body;
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

  const resA = await api(owner(), 'POST', '/gym', { name: `BranchGym ${suffix}` });
  gym = (await resA.json()).gym;
  createdGymIds.push(gym.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `OtherGym ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);
  await query('UPDATE gyms SET timezone = $2 WHERE id = $1', [gym.id, 'UTC']);

  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.deskMohali.email, gym_role: 'FRONT_DESK' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.trainerMohali.email, gym_role: 'TRAINER' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.trainerAny.email, gym_role: 'TRAINER' });
});

// ── branch CRUD + permissions ─────────────────────────────────────────────

test('owner creates branches; duplicate name 409; ADMIN may create; desk/trainer 403', async () => {
  const r1 = await api(owner(), 'POST', `/gym/${gym.id}/branches`,
    { name: 'Chandigarh', city: 'Chandigarh', phone: '+91172000000', timezone: 'Asia/Kolkata' });
  assert.strictEqual(r1.status, 201);
  chd = (await r1.json());
  assert.strictEqual(chd.status, 'ACTIVE');
  assert.strictEqual(chd.timezone, 'Asia/Kolkata');

  const r2 = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Mohali', timezone: 'Asia/Kolkata' });
  mohali = await r2.json();
  assert.strictEqual(r2.status, 201);
  const r3 = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Delhi', timezone: 'Asia/Kolkata' });
  delhi = await r3.json();

  const dup = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: '  mohali ' });
  assert.strictEqual(dup.status, 409);

  const other = await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/branches`, { name: 'Chandigarh' });
  assert.strictEqual(other.status, 201); // same name, different gym — fine

  const adminCreate = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gym.id}/branches`,
    { name: 'Panchkula' });
  assert.strictEqual(adminCreate.status, 201);

  const deskCreate = await api(tokens[PEOPLE.deskMohali.email], 'POST', `/gym/${gym.id}/branches`, { name: 'X' });
  assert.strictEqual(deskCreate.status, 403);
  const trainerCreate = await api(tokens[PEOPLE.trainerMohali.email], 'POST', `/gym/${gym.id}/branches`, { name: 'Y' });
  assert.strictEqual(trainerCreate.status, 403);

  const badTz = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Z', timezone: 'Mars/Olympus' });
  assert.strictEqual(badTz.status, 400);
});

test('branch list: all staff roles can read (selector), with member counts', async () => {
  const list = await (await api(owner(), 'GET', `/gym/${gym.id}/branches`)).json();
  assert.ok(list.length >= 4);
  const moh = list.find((b) => b.name === 'Mohali');
  assert.strictEqual(moh.members, 0);
  const deskList = await api(tokens[PEOPLE.deskMohali.email], 'GET', `/gym/${gym.id}/branches`);
  assert.strictEqual(deskList.status, 200);
  const trainerList = await api(tokens[PEOPLE.trainerMohali.email], 'GET', `/gym/${gym.id}/branches`);
  assert.strictEqual(trainerList.status, 200);
});

// ── members: primary + allowed branches, label sync, legacy members ───────

test('member primary/allowed branches; label sync keeps Phase 14 audiences working', async () => {
  legacyMember = await createMember({ first_name: 'Legacy' });
  chdMember = await createMember({ first_name: 'Chd', email: PEOPLE.mApp.email });
  mohaliMember = await createMember({ first_name: 'Moh' });
  cancelledMember = await createMember({ first_name: 'Gone' });
  await api(owner(), 'POST', `/gym/${gym.id}/members/${cancelledMember.id}/cancel`, { reason: 'left' });

  // legacy member: no primary, no allowed — all-branches behavior
  assert.strictEqual(legacyMember.primary_branch_id, null);

  let r = await api(owner(), 'PATCH', `/gym/${gym.id}/members/${chdMember.id}/branches`,
    { primary_branch_id: chd.id });
  assert.strictEqual(r.status, 200);
  // the free-form label (Phase 14 SPECIFIC_BRANCH) follows the primary branch
  const chdAfter = (await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${chdMember.id}`)).json());
  assert.strictEqual(chdAfter.branch, 'Chandigarh');

  // allowed branches: Mohali member may also use Chandigarh
  r = await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: mohali.id, allowed_branch_ids: [chd.id] });
  assert.strictEqual(r.status, 200);

  // allowed may not contain primary
  r = await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { allowed_branch_ids: [mohali.id] });
  assert.strictEqual(r.status, 400);

  // cross-gym branch rejected
  const otherBranches = await (await api(tokens[PEOPLE.owner2.email],
    'GET', `/gym/${gymB.id}/branches`)).json();
  r = await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: otherBranches[0].id });
  assert.strictEqual(r.status, 400);
});

// ── staff branch restriction ──────────────────────────────────────────────

test('staff branch changes: Front Desk restricted to Mohali; OWNER cannot be restricted', async () => {
  const staff = await (await api(owner(), 'GET', `/gym/${gym.id}/staff`)).json();
  const staffArr = Array.isArray(staff) ? staff : staff.staff;
  const desk = staffArr.find((s) => s.email === PEOPLE.deskMohali.email);
  const ownerRow = staffArr.find((s) => s.gym_role === 'OWNER');
  assert.ok(desk && ownerRow);

  const r = await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${desk.id}/branches`,
    { branch_ids: [mohali.id] });
  assert.strictEqual(r.status, 200);

  const deny = await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${ownerRow.id}/branches`,
    { branch_ids: [mohali.id] });
  assert.strictEqual(deny.status, 400);

  // restriction visible to the desk itself via /branches metadata? The desk
  // still reads the branch list (200) — enforcement happens on writes below.
  const list = await api(tokens[PEOPLE.deskMohali.email], 'GET', `/gym/${gym.id}/branches`);
  assert.strictEqual(list.status, 200);

  // invalid branch in the set
  const bad = await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${desk.id}/branches`,
    { branch_ids: [delhi.id, crypto.randomUUID()] });
  assert.strictEqual(bad.status, 400);
});

// ── branch-specific attendance + cross-branch QR ─────────────────────────

test('attendance tags the branch: explicit branch_id, else the member primary', async () => {
  // no branch given → the member's PRIMARY branch is assumed
  let r = await api(owner(), 'POST', `/gym/${gym.id}/members/${mohaliMember.id}/attendance`,
    { source: 'FRONT_DESK' });
  const autoBody = await r.json();
  assert.strictEqual(r.status, 201, `primary auto: ${r.status} ${JSON.stringify(autoBody)}`);
  assert.strictEqual(autoBody.attendance.branch_id, mohali.id);

  // explicit branch OUTSIDE the access set → rejected
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${mohaliMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: delhi.id });
  assert.strictEqual(r.status, 403, `expected 403 not-allowed branch, got ${r.status}`);

  // explicit branch INSIDE the allowed set → accepted (the same-day dedupe
  // rule may absorb it into the day's visit, which is the designed behavior)
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${mohaliMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: chd.id });
  assert.strictEqual([200, 201].includes(r.status), true,
    `allowed-branch check-in: ${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);

  // legacy member (no primary) → may check in anywhere, row tagged
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${legacyMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: delhi.id });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await r.json()).attendance.branch_id, delhi.id);
});

test('cross-branch QR: token works at allowed branches, rejected at not-allowed ones', async () => {
  const qr = await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${chdMember.id}/qr`)).json();

  // member's primary is Chandigarh — scanning at Mohali is NOT allowed
  let r = await api(owner(), 'POST', `/gym/${gym.id}/attendance/scan`,
    { qr_token: qr.qr_token, branch_id: mohali.id });
  assert.strictEqual(r.status, 403);

  // scanning at the primary branch works and tags the row
  r = await api(owner(), 'POST', `/gym/${gym.id}/attendance/scan`,
    { qr_token: qr.qr_token, branch_id: chd.id });
  assert.strictEqual([200, 201].includes(r.status), true, `scan: ${r.status}`);
  assert.strictEqual((await r.json()).attendance.branch_id, chd.id);

  // allow Chandigarh→Mohali access; the same-day dedupe rule means the
  // cross-branch scan is absorbed into the day's visit (200 duplicate) —
  // the point here is ACCESS: resolveVisitBranch ran before the dedupe and
  // a not-allowed branch would 403 before any of this
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${chdMember.id}/branches`,
    { primary_branch_id: chd.id, allowed_branch_ids: [mohali.id] });
  r = await api(owner(), 'POST', `/gym/${gym.id}/attendance/scan`,
    { qr_token: qr.qr_token, branch_id: mohali.id });
  assert.strictEqual([200, 201].includes(r.status), true, `cross scan: ${r.status}`);
  assert.strictEqual((await r.json()).duplicate, true);
});

// ── staff restriction enforcement ─────────────────────────────────────────

test('Front Desk restricted to Mohali cannot check members in elsewhere', async () => {
  const desk = tokens[PEOPLE.deskMohali.email];
  // Mohali: fine
  let r = await api(desk, 'POST', `/gym/${gym.id}/members/${legacyMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: mohali.id });
  assert.strictEqual([200, 201].includes(r.status), true, `desk mohali: ${r.status}`);
  // Delhi: outside the restriction
  r = await api(desk, 'POST', `/gym/${gym.id}/members/${legacyMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: delhi.id });
  assert.strictEqual(r.status, 403);
  // scan outside the restriction too
  const qr = await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${legacyMember.id}/qr`)).json();
  r = await api(desk, 'POST', `/gym/${gym.id}/attendance/scan`,
    { qr_token: qr.qr_token, branch_id: chd.id });
  assert.strictEqual(r.status, 403);
});

// ── branch transfer + history ─────────────────────────────────────────────

test('branch transfer moves the primary, appends history, old attendance untouched', async () => {
  // historical data: a pre-transfer attendance row exists at Chandigarh
  const chdRows = await query(
    'SELECT COUNT(*)::int AS n FROM gym_attendance WHERE member_id = $1 AND branch_id = $2',
    [chdMember.id, chd.id]);
  assert.ok(chdRows.rows[0].n >= 1);

  const r = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/transfer-branch`,
    { to_branch_id: delhi.id, reason: 'moved cities' });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.member.primary_branch_id, delhi.id);
  assert.strictEqual(body.transfer.from_branch_id, chd.id);
  assert.strictEqual(body.transfer.to_branch_id, delhi.id);
  assert.strictEqual(body.transfer.reason, 'moved cities');

  // label follows the new branch (Phase 14 compat)
  const member = await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${chdMember.id}`)).json();
  assert.strictEqual(member.branch, 'Delhi');

  // transfer to the SAME branch is a 409
  const dup = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/transfer-branch`,
    { to_branch_id: delhi.id });
  assert.strictEqual(dup.status, 409);

  // history is append-only and readable
  const hist = await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${chdMember.id}/branch-history`)).json();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].from_branch_name, 'Chandigarh');
  assert.strictEqual(hist[0].to_branch_name, 'Delhi');

  // the old Chandigarh attendance rows are untouched (historical data)
  const after = await query(
    'SELECT COUNT(*)::int AS n FROM gym_attendance WHERE member_id = $1 AND branch_id = $2',
    [chdMember.id, chd.id]);
  assert.strictEqual(after.rows[0].n, chdRows.rows[0].n);
});

// ── branch closure ────────────────────────────────────────────────────────

test('branch closure blocks NEW check-ins; reopen restores; history kept', async () => {
  let r = await api(owner(), 'POST', `/gym/${gym.id}/branches/${delhi.id}/close`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).status, 'INACTIVE');

  // idempotent close
  r = await api(owner(), 'POST', `/gym/${gym.id}/branches/${delhi.id}/close`);
  assert.strictEqual(r.status, 200);

  // the member's primary branch is closed → auto-resolution rejects
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/attendance`,
    { source: 'FRONT_DESK' });
  assert.strictEqual(r.status, 409);

  // explicit scan at the closed branch rejects too
  const qr = await (await api(owner(), 'GET',
    `/gym/${gym.id}/members/${chdMember.id}/qr`)).json();
  r = await api(owner(), 'POST', `/gym/${gym.id}/attendance/scan`,
    { qr_token: qr.qr_token, branch_id: delhi.id });
  assert.strictEqual(r.status, 409);

  // reopen restores check-ins
  r = await api(owner(), 'POST', `/gym/${gym.id}/branches/${delhi.id}/reopen`);
  assert.strictEqual(r.status, 200);
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/attendance`,
    { source: 'FRONT_DESK', branch_id: mohali.id }); // mohali ∈ allowed_branches
  assert.strictEqual([200, 201].includes(r.status), true, `after reopen: ${r.status}`);
});

// ── trainer multiple branches ─────────────────────────────────────────────

test('trainer multiple branches: restricted trainer only takes reachable members', async () => {
  const staff = await (await api(owner(), 'GET', `/gym/${gym.id}/staff`)).json();
  const staffArr = Array.isArray(staff) ? staff : staff.staff;
  const trainerM = staffArr.find((s) => s.email === PEOPLE.trainerMohali.email);

  // restrict the trainer to Mohali
  const r = await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${trainerM.id}/branches`,
    { branch_ids: [mohali.id] });
  assert.strictEqual(r.status, 200);

  // mohaliMember primary = Mohali → OK
  let a = await api(owner(), 'POST', `/gym/${gym.id}/members/${mohaliMember.id}/trainer`,
    { trainer_staff_id: trainerM.id });
  assert.strictEqual(a.status, 201, `mohali assign: ${a.status} ${JSON.stringify(await a.json())}`);

  // reset allowed branches to [] — then Delhi primary is unreachable by a
  // Mohali-only trainer
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${chdMember.id}/branches`,
    { primary_branch_id: delhi.id, allowed_branch_ids: [] });
  a = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/trainer`,
    { trainer_staff_id: trainerM.id });
  assert.strictEqual(a.status, 409);

  // allow Mohali on chdMember → reachable through allowed_branches
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${chdMember.id}/branches`,
    { primary_branch_id: delhi.id, allowed_branch_ids: [mohali.id] });
  a = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/trainer`,
    { trainer_staff_id: trainerM.id });
  assert.strictEqual(a.status, 201, `allowed-branch assign: ${a.status}`);

  // unrestricted trainer can take anyone
  const trainerAny = staffArr.find((s) => s.email === PEOPLE.trainerAny.email);
  a = await api(owner(), 'POST', `/gym/${gym.id}/members/${legacyMember.id}/trainer`,
    { trainer_staff_id: trainerAny.id });
  assert.strictEqual(a.status, 201);
});

// ── branch-specific plans ─────────────────────────────────────────────────

test('branch-specific plans: assignment guarded by the member primary branch', async () => {
  let r = await api(owner(), 'POST', `/gym/${gym.id}/plans`,
    { name: `Delhi Only ${suffix}`, price_cents: 100000, duration_value: 1,
      duration_unit: 'month', status: 'ACTIVE', branch_ids: [delhi.id] });
  assert.strictEqual(r.status, 201);
  planId = (await r.json()).id;

  // mohaliMember (primary Mohali) cannot get a Delhi-only plan
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${mohaliMember.id}/memberships`,
    { plan_id: planId });
  assert.strictEqual(r.status, 400);

  // legacy member without a primary cannot either (needs a primary first)
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${legacyMember.id}/memberships`,
    { plan_id: planId });
  assert.strictEqual(r.status, 400);

  // chdMember's primary is Delhi → OK
  r = await api(owner(), 'POST', `/gym/${gym.id}/members/${chdMember.id}/memberships`,
    { plan_id: planId });
  assert.strictEqual(r.status, 201, `delhi assign: ${r.status} ${JSON.stringify(await r.json())}`);

  // invalid branch ids on the plan
  r = await api(owner(), 'POST', `/gym/${gym.id}/plans`,
    { name: 'Bad Branch Plan', price_cents: 1, duration_value: 1, duration_unit: 'month',
      status: 'ACTIVE', branch_ids: [crypto.randomUUID()] });
  assert.strictEqual(r.status, 400);
});

// ── dashboard [All Branches ▼] ────────────────────────────────────────────

test('dashboard: All Branches totals vs branch-scoped view; selector data included', async () => {
  const all = await (await api(owner(), 'GET', `/gym/${gym.id}/dashboard`)).json();
  assert.strictEqual(all.branch_filter, null);
  // members.total = every bucket incl. CANCELLED (Phase 15 semantics):
  // legacy + mohali + chd + gone = 4
  assert.strictEqual(all.members.total, 4);
  assert.strictEqual(all.branches.length, 4); // Chandigarh, Mohali, Delhi, Panchkula (other gym excluded)
  const delhiRow = all.branches.find((b) => b.name === 'Delhi');
  assert.strictEqual(delhiRow.members, 1); // chdMember transferred here

  // scoped to Delhi: only chdMember
  const delhiView = await (await api(owner(), 'GET',
    `/gym/${gym.id}/dashboard?branch_id=${delhi.id}`)).json();
  assert.strictEqual(delhiView.branch_filter.id, delhi.id);
  assert.strictEqual(delhiView.members.total, 1);
  assert.strictEqual(delhiView.app_adoption.total, 1);
  assert.strictEqual(delhiView.branches.length, 4); // selector data always full

  // attendance is branch-specific: Delhi has chdMember's visit today
  assert.strictEqual(delhiView.attendance.today, 1);
  // all-branch attendance counts every tagged visit today (chd scan x2 +
  // mohali primary + legacy delhi + desk mohali + reopened chd visit etc.)
  assert.ok(all.attendance.today >= delhiView.attendance.today);

  // scoped to Panchkula (empty branch): clean zeros
  const panch = all.branches.find((b) => b.name === 'Panchkula');
  const emptyView = await (await api(owner(), 'GET',
    `/gym/${gym.id}/dashboard?branch_id=${panch.id}`)).json();
  assert.strictEqual(emptyView.members.total, 0);
  assert.strictEqual(emptyView.attendance.today, 0);
  assert.strictEqual(emptyView.financial.collected_cents, 0);

  // bad branch id → 404
  const bad = await api(owner(), 'GET',
    `/gym/${gym.id}/dashboard?branch_id=${crypto.randomUUID()}`);
  assert.strictEqual(bad.status, 404);

  // front desk (restricted to Mohali) may still READ the dashboard? No —
  // reports.view is OWNER/ADMIN only.
  assert.strictEqual((await api(tokens[PEOPLE.deskMohali.email],
    'GET', `/gym/${gym.id}/dashboard`)).status, 403);
});

// ── historical data & isolation ───────────────────────────────────────────

test('cross-gym isolation: branches, staff restrictions and transfers are gym-scoped', async () => {
  // gym B has its own Chandigarh; gym A's branch ids do not resolve there
  const bBranches = await (await api(tokens[PEOPLE.owner2.email],
    'GET', `/gym/${gymB.id}/branches`)).json();
  assert.strictEqual(bBranches.length, 1);

  const r = await api(tokens[PEOPLE.owner2.email], 'PATCH',
    `/gym/${gymB.id}/members/${legacyMember.id}/branches`, {});
  assert.strictEqual(r.status, 404); // member belongs to gym A

  const steal = await api(tokens[PEOPLE.owner2.email], 'PATCH',
    `/gym/${gymB.id}/branches/${chd.id}`, { name: 'Hacked' });
  assert.strictEqual(steal.status, 404);

  const transfer = await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymB.id}/members/${legacyMember.id}/transfer-branch`,
    { to_branch_id: bBranches[0].id });
  assert.strictEqual(transfer.status, 404);
});

test('permissions: branches.manage is OWNER/ADMIN; members.manage guards branch writes', async () => {
  // FRONT_DESK cannot create/close/transfer/restrict
  const desk = tokens[PEOPLE.deskMohali.email];
  assert.strictEqual((await api(desk, 'POST', `/gym/${gym.id}/branches/${mohali.id}/close`)).status, 403);
  assert.strictEqual((await api(desk, 'POST',
    `/gym/${gym.id}/members/${legacyMember.id}/transfer-branch`, { to_branch_id: mohali.id })).status, 403);
  assert.strictEqual((await api(desk, 'PATCH',
    `/gym/${gym.id}/members/${legacyMember.id}/branches`, { primary_branch_id: mohali.id })).status, 403);

  // TRAINER cannot either
  const tr = tokens[PEOPLE.trainerMohali.email];
  assert.strictEqual((await api(tr, 'POST', `/gym/${gym.id}/branches/${mohali.id}/close`)).status, 403);

  // ADMIN can manage branches and member branches
  assert.strictEqual((await api(tokens[PEOPLE.admin.email], 'PATCH',
    `/gym/${gym.id}/members/${legacyMember.id}/branches`,
    { primary_branch_id: chd.id, allowed_branch_ids: [mohali.id] })).status, 200);
});

test.after(async () => {
  if (createdGymIds.length) {
    await query('DELETE FROM gyms WHERE id = ANY($1::uuid[])', [createdGymIds]);
  }
  if (createdUserIds.length) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  }
  await pool.end();
  server.close();
});
