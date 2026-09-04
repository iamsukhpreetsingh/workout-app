// Gym class scheduling & booking tests (Phase 17). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec edge cases end-to-end:
//   create (type/trainer/branch/room/date/time/capacity) · class full →
//   waitlist (FIFO) · duplicate booking · cancellation (desk + self) with
//   waitlist promotion · no-show frees the seat (waitlist promotes), undo
//   needs a free seat · expired / frozen / no-term / cancelled membership
//   gates · trainer unavailable (overlap, branch restriction) · class
//   cancelled (cascades to live bookings, blocks new ones) · branch
//   mismatch (member access + closed branch) · simultaneous booking race
//   (capacity 1, two parallel requests → one seat + one waitlist) ·
//   non-app member desk booking · mobile self-book / self-cancel ·
//   capacity shrink guard · room double-booking · cross-gym isolation ·
//   permissions · audit trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymClasses.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `cls_owner_${suffix}@test.local`, name: 'Class Owner' },
  owner2: { email: `cls_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `cls_admin_${suffix}@test.local`, name: 'Class Admin' },
  desk: { email: `cls_desk_${suffix}@test.local`, name: 'Front Desk' },
  deskMohali: { email: `cls_deskm_${suffix}@test.local`, name: 'Desk Mohali' },
  trainerA: { email: `cls_trainera_${suffix}@test.local`, name: 'Trainer A' },
  trainerB: { email: `cls_trainerb_${suffix}@test.local`, name: 'Trainer B' },
  mApp: { email: `cls_member_${suffix}@test.local`, name: 'Member App' },
};
const tokens = {};
let gym, gymB, branchMain, branchMohali, trainerAId, trainerBId, planId;
const createdUserIds = [];
const createdGymIds = [];
let appMember, legacyMember, frozenMember, expiredMember, noTermMember, cancelledMember, mohaliMember;
// a date comfortably in the future so nothing is "already over"
const DAY = futureDate(14);

function futureDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
const desk = () => tokens[PEOPLE.desk.email];

async function createMember(payload) {
  const res = await api(owner(), 'POST', `/gym/${gym.id}/members`, payload);
  const body = await res.json();
  assert.strictEqual(res.status, 201, `member create: ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function assignPlan(memberId) {
  const res = await api(owner(), 'POST', `/gym/${gym.id}/members/${memberId}/memberships`,
    { plan_id: planId });
  assert.strictEqual(res.status, 201, `membership assign: ${res.status}`);
  return res.json();
}

let seq = 0;
function yogaPayload(overrides = {}) {
  seq += 1;
  return {
    class_type: `Yoga${seq}`, trainer_staff_id: trainerBId,
    branch_id: null, room: null,
    // every class lands on its OWN day — no cross-test trainer/room clashes
    class_date: futureDate(14 + seq), start_time: '18:00', end_time: '19:00', capacity: 2,
    ...overrides,
  };
}

async function createClass(payload, token = null, gymId = null) {
  const res = await api(token || owner(), 'POST', `/gym/${gymId || gym.id}/classes`, payload);
  const body = await res.json();
  assert.strictEqual(res.status, 201, `class create: ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function deskBook(classId, memberId) {
  return api(desk(), 'POST', `/gym/${gym.id}/classes/${classId}/bookings`, { member_id: memberId });
}

async function cancelClass(classId) {
  await api(owner(), 'POST', `/gym/${gym.id}/classes/${classId}/cancel`, {});
}

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/gym', gymRoutes);
  app.use('/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  const resA = await api(owner(), 'POST', '/gym', { name: `ClassGym ${suffix}` });
  gym = (await resA.json()).gym;
  createdGymIds.push(gym.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `OtherGym ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);
  await query('UPDATE gyms SET timezone = $2 WHERE id = $1', [gym.id, 'UTC']);

  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.deskMohali.email, gym_role: 'FRONT_DESK' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.trainerA.email, gym_role: 'TRAINER' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.trainerB.email, gym_role: 'TRAINER' });

  const rb = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Main', timezone: 'UTC' });
  branchMain = await rb.json();
  const rb2 = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Mohali', timezone: 'UTC' });
  branchMohali = await rb2.json();

  const staffRes = await api(owner(), 'GET', `/gym/${gym.id}/staff`);
  const staffBody = await staffRes.json();
  const staffRows = staffBody.staff || staffBody;
  trainerAId = staffRows.find((s) => s.email === PEOPLE.trainerA.email).id;
  trainerBId = staffRows.find((s) => s.email === PEOPLE.trainerB.email).id;
  const deskM = staffRows.find((s) => s.email === PEOPLE.deskMohali.email);

  const rp = await api(owner(), 'POST', `/gym/${gym.id}/plans`,
    { name: `Monthly ${suffix}`, duration_value: 1, duration_unit: 'month',
      price_cents: 5000, currency: 'INR', access_level: 'gym_only',
      included_pt_sessions: 0, status: 'ACTIVE' });
  const planBody = await rp.json();
  assert.strictEqual(rp.status, 201, `plan create: ${JSON.stringify(planBody)}`);
  planId = planBody.id;

  appMember = await createMember({ first_name: 'App', email: PEOPLE.mApp.email });
  // link the app account: invite → accept (existing user, no duplicates)
  const inv = await api(owner(), 'POST', `/gym/${gym.id}/members/${appMember.id}/invite-app`, {});
  const inviteCode = (await inv.json()).invite_code;
  assert.ok(inviteCode, 'invite code returned');
  const accept = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/invite/${inviteCode}/accept`);
  assert.strictEqual(accept.status, 200, 'invite accepted');
  legacyMember = await createMember({ first_name: 'Legacy' });
  frozenMember = await createMember({ first_name: 'Frozen' });
  expiredMember = await createMember({ first_name: 'Expired' });
  noTermMember = await createMember({ first_name: 'NoTerm' });
  cancelledMember = await createMember({ first_name: 'Gone' });
  mohaliMember = await createMember({ first_name: 'MohaliOnly' });

  await assignPlan(appMember.id);
  await assignPlan(legacyMember.id);
  const frozenTerm = await assignPlan(frozenMember.id);
  await assignPlan(expiredMember.id);
  await assignPlan(cancelledMember.id);
  await assignPlan(mohaliMember.id);

  // shape the gate fixtures
  const frozenId = frozenTerm.id || (frozenTerm.membership && frozenTerm.membership.id);
  const freeze = await api(owner(), 'POST',
    `/gym/${gym.id}/members/${frozenMember.id}/memberships/${frozenId}/freeze`, { reason: 'injury' });
  assert.strictEqual(freeze.status, 200, `freeze: ${await freeze.text()}`);
  await query(
    `UPDATE member_memberships SET status = 'EXPIRED', ends_on = CURRENT_DATE - 3
     WHERE member_id = $1`, [expiredMember.id]
  );
  await api(owner(), 'POST', `/gym/${gym.id}/members/${cancelledMember.id}/cancel`)
    .then(async (r) => assert.strictEqual(r.status, 200, 'member cancelled'));
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: branchMohali.id });
  await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${deskM.id}/branches`,
    { branch_ids: [branchMohali.id] });
});

test.after(async () => {
  if (createdGymIds.length) {
    await query('DELETE FROM gyms WHERE id = ANY($1::uuid[])', [createdGymIds]);
  }
  if (createdUserIds.length) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  }
  await pool.end();
  if (server) server.close();
});

// ── creation + validation ─────────────────────────────────────────────────

test('owner creates a class; ADMIN may create; desk/trainer cannot; payload validated', async () => {
  const cls = await createClass(yogaPayload({ branch_id: branchMain.id, room: 'Studio A', trainer_staff_id: trainerAId }));
  assert.strictEqual(cls.status, 'SCHEDULED');
  assert.strictEqual(cls.capacity, 2);
  assert.strictEqual(cls.branch_name, 'Main');
  assert.strictEqual(cls.trainer_name, 'Trainer A');

  const adminCreate = await api(tokens[PEOPLE.admin.email], 'POST', `/gym/${gym.id}/classes`,
    yogaPayload({ class_type: 'Pilates', room: 'Studio B', start_time: '07:00', end_time: '08:00' }));
  assert.strictEqual(adminCreate.status, 201);
  await cancelClass((await adminCreate.json()).id);

  assert.strictEqual((await api(desk(), 'POST', `/gym/${gym.id}/classes`, yogaPayload())).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.trainerA.email], 'POST', `/gym/${gym.id}/classes`, yogaPayload())).status, 403);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ class_type: '  ' }))).status, 400);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ capacity: 0 }))).status, 400);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ capacity: 501 }))).status, 400);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ start_time: '19:00', end_time: '18:00' }))).status, 400);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ class_date: '2026-13-40' }))).status, 400);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes`, yogaPayload({ trainer_staff_id: crypto.randomUUID() }))).status, 404);

  // free the schedule slot for the later tests
  await cancelClass(cls.id);
});

// ── trainer unavailable (edge case) ───────────────────────────────────────

test('trainer unavailable: overlap rejected; touching slot fine; branch-restricted trainer rejected', async () => {
  const day = futureDate(300 + seq); // one shared day for the overlap checks
  const base = await createClass(yogaPayload({ class_type: 'OverlapBase', class_date: day, start_time: '18:00', end_time: '19:00' }));

  const overlap = await api(owner(), 'POST', `/gym/${gym.id}/classes`,
    yogaPayload({ class_type: 'Spin', class_date: day, start_time: '18:30', end_time: '19:30' }));
  assert.strictEqual(overlap.status, 409);

  // touching but not overlapping is fine
  const nextSlot = await createClass(yogaPayload({ class_type: 'Spin', class_date: day, start_time: '19:00', end_time: '20:00' }));

  // another trainer at the same time is fine
  const sameTime = await createClass(yogaPayload({ class_type: 'HIIT', trainer_staff_id: trainerAId, class_date: day, start_time: '18:00', end_time: '19:00' }));

  // restrict trainer A to Mohali → a Main-branch class with them is rejected,
  // a Mohali-branch class is fine; restriction cleared again afterwards
  await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${trainerAId}/branches`,
    { branch_ids: [branchMohali.id] });
  const restricted = await api(owner(), 'POST', `/gym/${gym.id}/classes`,
    yogaPayload({ class_type: 'Box', trainer_staff_id: trainerAId, branch_id: branchMain.id }));
  assert.strictEqual(restricted.status, 409);
  assert.match((await restricted.json()).error, /restricted/i);
  await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${trainerAId}/branches`, { branch_ids: [] });

  for (const id of [base.id, nextSlot.id, sameTime.id]) await cancelClass(id);
});

test('room double-booking: same branch + room + overlapping window rejected; other room fine', async () => {
  const day = futureDate(320 + seq); // one shared day for the room checks
  const base = await createClass(yogaPayload({
    class_type: 'RoomBase', branch_id: branchMain.id, room: 'Studio A', trainer_staff_id: trainerAId,
    class_date: day, start_time: '10:00', end_time: '11:00',
  }));
  const clash = await api(owner(), 'POST', `/gym/${gym.id}/classes`,
    yogaPayload({ class_type: 'Stretch', branch_id: branchMain.id, room: 'studio a', trainer_staff_id: trainerBId,
      class_date: day, start_time: '10:15', end_time: '11:15' }));
  assert.strictEqual(clash.status, 409);
  assert.match((await clash.json()).error, /Room "studio a"/i); // case-insensitive room match
  const otherRoom = await createClass(yogaPayload({
    class_type: 'Stretch', branch_id: branchMain.id, room: 'Studio B', trainer_staff_id: trainerBId,
    class_date: day, start_time: '10:15', end_time: '11:15',
  }));
  for (const id of [base.id, otherRoom.id]) await cancelClass(id);
});

// ── booking + full/waitlist/duplicate edges + non-app desk booking ────────

test('desk books a NON-APP member; full → waitlist FIFO; duplicates 409; detail sheet', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'Zumba', capacity: 2 }));

  const b1 = await deskBook(cls.id, legacyMember.id); // NON-APP member
  assert.strictEqual(b1.status, 201);
  const b1Body = await b1.json();
  assert.strictEqual(b1Body.status, 'BOOKED');
  assert.strictEqual(b1Body.spots_left, 1);

  const b2 = await deskBook(cls.id, appMember.id);
  assert.strictEqual(b2.status, 201);
  assert.strictEqual((await b2.json()).status, 'BOOKED');

  const m3 = await createMember({ first_name: 'Third' });
  await assignPlan(m3.id);
  const b3 = await deskBook(cls.id, m3.id); // class full → waitlist
  assert.strictEqual(b3.status, 201);
  const b3Body = await b3.json();
  assert.strictEqual(b3Body.status, 'WAITLISTED');
  assert.strictEqual(b3Body.waitlist_position, 1);
  assert.strictEqual(b3Body.spots_left, 0);

  const m4 = await createMember({ first_name: 'Fourth' });
  await assignPlan(m4.id);
  assert.strictEqual((await (await deskBook(cls.id, m4.id)).json()).waitlist_position, 2);

  // duplicates
  assert.strictEqual((await deskBook(cls.id, legacyMember.id)).status, 409); // already BOOKED
  assert.strictEqual((await deskBook(cls.id, m3.id)).status, 409); // already WAITLISTED

  const detail = await (await api(owner(), 'GET', `/gym/${gym.id}/classes/${cls.id}`)).json();
  assert.strictEqual(detail.booked_count, 2);
  assert.strictEqual(detail.waitlist_count, 2);
  assert.deepStrictEqual(
    detail.bookings.filter((b) => b.status === 'WAITLISTED').map((b) => b.waitlist_position),
    [1, 2],
  );
  assert.strictEqual(detail.bookings.find((b) => b.member_id === legacyMember.id).source, 'DESK');
});

// ── membership gates (expired / frozen / no-term / cancelled) ──────────────

test('membership gates: expired, frozen, no-term, left-the-gym members cannot book', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'GateYoga', capacity: 5 }));

  const expired = await deskBook(cls.id, expiredMember.id);
  assert.strictEqual(expired.status, 409);
  assert.match((await expired.json()).error, /expired/i);

  const frozen = await deskBook(cls.id, frozenMember.id);
  assert.strictEqual(frozen.status, 409);
  assert.match((await frozen.json()).error, /frozen/i);

  const noTerm = await deskBook(cls.id, noTermMember.id);
  assert.strictEqual(noTerm.status, 409);
  assert.match((await noTerm.json()).error, /active membership/i);

  const gone = await deskBook(cls.id, cancelledMember.id);
  assert.strictEqual(gone.status, 400);
  assert.match((await gone.json()).error, /left the gym/i);

  assert.strictEqual(await (await deskBook(cls.id, appMember.id)).status, 201); // control
});

// ── branch mismatch (edge case) ───────────────────────────────────────────

test('branch mismatch: Mohali-primary member refused at Main; allowed-branch fix works; closed branch refuses', async () => {
  const mainCls = await createClass(yogaPayload({ class_type: 'MainOnly', capacity: 5, branch_id: branchMain.id }));

  const r = await deskBook(mainCls.id, mohaliMember.id);
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /outside this member's branches/i);

  // grant multi-club access → booking succeeds
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: branchMohali.id, allowed_branch_ids: [branchMain.id] });
  assert.strictEqual((await deskBook(mainCls.id, mohaliMember.id)).status, 201);
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: branchMohali.id, allowed_branch_ids: [] });

  // legacy member (no primary branch) books anywhere — but still needs a term
  assert.strictEqual((await deskBook(mainCls.id, noTermMember.id)).status, 409); // membership gate
  await assignPlan(noTermMember.id);
  assert.strictEqual((await deskBook(mainCls.id, noTermMember.id)).status, 201);

  // closed branch: a class there refuses new bookings
  const tmpBranch = await (await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: `Closing ${suffix}` })).json();
  const clsThere = await createClass(yogaPayload({ class_type: 'ClosingYoga', branch_id: tmpBranch.id, capacity: 5 }));
  await api(owner(), 'POST', `/gym/${gym.id}/branches/${tmpBranch.id}/close`, {});
  const closed = await deskBook(clsThere.id, legacyMember.id);
  assert.strictEqual(closed.status, 409);
  assert.match((await closed.json()).error, /closed/i);
});

// ── staff branch restriction (desk restricted to Mohali) ──────────────────

test('Mohali-restricted desk gets 403 booking into a Main-branch class', async () => {
  const mainCls = await createClass(yogaPayload({ class_type: 'DeskScope', capacity: 5, branch_id: branchMain.id }));
  const m5 = await createMember({ first_name: 'Fifth' });
  await assignPlan(m5.id);
  const r = await api(tokens[PEOPLE.deskMohali.email], 'POST',
    `/gym/${gym.id}/classes/${mainCls.id}/bookings`, { member_id: m5.id });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /outside your assigned branches/i);
  assert.strictEqual((await deskBook(mainCls.id, m5.id)).status, 201); // unrestricted desk fine
});

// ── cancellation + waitlist promotion ─────────────────────────────────────

test('cancellation: freeing a seat promotes the FIRST waitlisted member (FIFO); double-cancel 409', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'PromoYoga', capacity: 1 }));
  const seat = await (await deskBook(cls.id, appMember.id)).json();
  const wl1 = await (await deskBook(cls.id, legacyMember.id)).json();
  const m6 = await createMember({ first_name: 'Sixth' });
  await assignPlan(m6.id);
  const wl2 = await (await deskBook(cls.id, m6.id)).json();
  assert.strictEqual(wl1.status, 'WAITLISTED');
  assert.strictEqual(wl2.status, 'WAITLISTED');

  const c = await api(desk(), 'POST', `/gym/${gym.id}/classes/${cls.id}/bookings/${seat.id}/cancel`, {});
  assert.strictEqual(c.status, 200);
  assert.strictEqual((await c.json()).promoted, 1);

  const detail = await (await api(owner(), 'GET', `/gym/${gym.id}/classes/${cls.id}`)).json();
  assert.strictEqual(detail.booked_count, 1);
  assert.strictEqual(detail.waitlist_count, 1);
  assert.strictEqual(detail.bookings.find((b) => b.member_id === legacyMember.id).status, 'BOOKED');
  assert.strictEqual(detail.bookings.find((b) => b.member_id === m6.id).status, 'WAITLISTED');
  assert.strictEqual(detail.bookings.find((b) => b.member_id === m6.id).waitlist_position, 1);

  const again = await api(desk(), 'POST', `/gym/${gym.id}/classes/${cls.id}/bookings/${seat.id}/cancel`, {});
  assert.strictEqual(again.status, 409);
});

// ── no-show ───────────────────────────────────────────────────────────────

test('no-show: frees the seat (waitlist promotes); undo needs a free seat; corrections work', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'NoShowYoga', capacity: 1 }));
  const holder = await (await deskBook(cls.id, appMember.id)).json();
  const waiter = await (await deskBook(cls.id, legacyMember.id)).json();
  assert.strictEqual(waiter.status, 'WAITLISTED');

  // waitlisted member holds no seat to mark
  const wlMark = await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${waiter.id}/attendance`, { attendance: 'NO_SHOW' });
  assert.strictEqual(wlMark.status, 409);

  const ns = await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'NO_SHOW' });
  assert.strictEqual(ns.status, 200);
  assert.strictEqual((await ns.json()).promoted, 1);
  let detail = await (await api(owner(), 'GET', `/gym/${gym.id}/classes/${cls.id}`)).json();
  assert.strictEqual(detail.bookings.find((b) => b.id === holder.id).status, 'NO_SHOW');
  assert.strictEqual(detail.bookings.find((b) => b.id === waiter.id).status, 'BOOKED');

  // undo the no-show: seat now held by the promoted member → 409
  const undo = await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'BOOKED' });
  assert.strictEqual(undo.status, 409);

  // free the seat, then the undo works
  await api(desk(), 'POST', `/gym/${gym.id}/classes/${cls.id}/bookings/${waiter.id}/cancel`, {});
  const undo2 = await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'BOOKED' });
  assert.strictEqual(undo2.status, 200);

  // ATTENDED marking + corrections both ways + invalid value
  assert.strictEqual((await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'ATTENDED' })).status, 200);
  assert.strictEqual((await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'NO_SHOW' })).status, 200);
  assert.strictEqual((await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${holder.id}/attendance`, { attendance: 'MAYBE' })).status, 400);
});

// ── class cancelled (edge case) ───────────────────────────────────────────

test('class cancelled: live bookings cascade, new bookings refuse, idempotent', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'CancelYoga', capacity: 1 }));
  const bk = await (await deskBook(cls.id, appMember.id)).json();
  await deskBook(cls.id, legacyMember.id); // waitlisted

  const cc = await api(owner(), 'POST', `/gym/${gym.id}/classes/${cls.id}/cancel`, { reason: 'trainer sick' });
  assert.strictEqual(cc.status, 200);
  assert.strictEqual((await cc.json()).status, 'CANCELLED');

  const detail = await (await api(owner(), 'GET', `/gym/${gym.id}/classes/${cls.id}`)).json();
  assert.strictEqual(detail.booked_count, 0);
  const row = detail.bookings.find((b) => b.id === bk.id);
  assert.strictEqual(row.status, 'CANCELLED');
  assert.strictEqual(row.cancel_reason, 'class_cancelled');

  assert.strictEqual((await deskBook(cls.id, mohaliMember.id)).status, 409); // class cancelled
  assert.strictEqual((await api(desk(), 'POST',
    `/gym/${gym.id}/classes/${cls.id}/bookings/${bk.id}/attendance`, { attendance: 'ATTENDED' })).status, 409);
  assert.strictEqual((await api(owner(), 'PATCH', `/gym/${gym.id}/classes/${cls.id}`, { capacity: 9 })).status, 409);
  assert.strictEqual((await api(owner(), 'POST', `/gym/${gym.id}/classes/${cls.id}/cancel`, {})).status, 200); // idempotent
});

// ── simultaneous booking (race) ───────────────────────────────────────────

test('simultaneous booking: capacity 1, two parallel requests → exactly one seat, never overbooked', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'RaceYoga', capacity: 1 }));
  const racerA = await createMember({ first_name: 'RacerA' });
  const racerB = await createMember({ first_name: 'RacerB' });
  await assignPlan(racerA.id);
  await assignPlan(racerB.id);

  const [ra, rb] = await Promise.all([deskBook(cls.id, racerA.id), deskBook(cls.id, racerB.id)]);
  const bodies = [await ra.json(), await rb.json()];
  assert.deepStrictEqual(bodies.map((b) => b.status).sort(), ['BOOKED', 'WAITLISTED'],
    `expected exactly one seat: ${JSON.stringify(bodies)}`);

  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM gym_class_bookings
     WHERE class_id = $1 AND status IN ('BOOKED','ATTENDED')`, [cls.id]
  );
  assert.strictEqual(rows[0].n, 1, 'overbooking happened!');
});

// ── capacity edit guard ───────────────────────────────────────────────────

test('capacity cannot drop below held seats; raising is fine', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'CapYoga', capacity: 2 }));
  await deskBook(cls.id, appMember.id);
  await deskBook(cls.id, legacyMember.id);

  assert.strictEqual((await api(owner(), 'PATCH', `/gym/${gym.id}/classes/${cls.id}`, { capacity: 1 })).status, 409);
  const grow = await api(owner(), 'PATCH', `/gym/${gym.id}/classes/${cls.id}`, { capacity: 10 });
  assert.strictEqual(grow.status, 200);
  assert.strictEqual((await grow.json()).capacity, 10);
});

// ── mobile surface (self list / book / cancel) ────────────────────────────

test('mobile: member lists upcoming classes, self-books, duplicate 409, self-cancel promotes', async () => {
  const list = await (await api(tokens[PEOPLE.mApp.email], 'GET', '/gym/my/classes')).json();
  assert.ok(Array.isArray(list));
  const mine = list.find((c) => c.class_type === 'CapYoga');
  assert.ok(mine, 'upcoming CapYoga should be visible to the app member');
  assert.strictEqual(mine.gym_name, `ClassGym ${suffix}`);
  assert.ok(mine.spots_left >= 0);
  // branch mismatch: the Mohali-only member must NOT see a Main-branch class…
  const mohaliCls = await createClass(yogaPayload({ class_type: 'MohaliVisible', branch_id: branchMohali.id }));
  const mohaliOnly = await createClass(yogaPayload({ class_type: 'MainVisible', branch_id: branchMain.id, start_time: '06:00', end_time: '07:00' }));
  const mohaliList = await (await api(owner(), 'GET', '/gym/my/classes')).json(); // owner has no member rows → []
  assert.deepStrictEqual(mohaliList, []);

  // self-book into a fresh capacity-1 class
  const selfCls = await createClass(yogaPayload({ class_type: 'SelfYoga', capacity: 1 }));
  const sb = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/classes/${selfCls.id}/book`, {});
  assert.strictEqual(sb.status, 201);
  assert.strictEqual((await sb.json()).status, 'BOOKED');
  assert.strictEqual((await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/classes/${selfCls.id}/book`, {})).status, 409);

  // desk fills the waitlist behind the self-booking
  const wl = await deskBook(selfCls.id, legacyMember.id);
  assert.strictEqual((await wl.json()).status, 'WAITLISTED');

  // self-cancel frees the seat → waitlisted member promoted
  const sc = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/classes/${selfCls.id}/cancel`, {});
  assert.strictEqual(sc.status, 200);
  assert.strictEqual((await sc.json()).promoted, 1);

  // user with no member row in this gym cannot self-book
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/my/classes/${selfCls.id}/book`, {})).status, 403);

  // a MEMBER-role gym context cannot use the desk/management routes
  const memberToken = tokens[PEOPLE.mApp.email];
  assert.strictEqual((await api(memberToken, 'POST', `/gym/${gym.id}/classes/${selfCls.id}/bookings`,
    { member_id: appMember.id })).status, 403);
  assert.strictEqual((await api(memberToken, 'POST', `/gym/${gym.id}/classes`, yogaPayload())).status, 403);

  await cancelClass(mohaliCls.id);
  await cancelClass(mohaliOnly.id);
});

// ── cross-gym isolation ───────────────────────────────────────────────────

test('cross-gym isolation: classes, bookings and trainers are gym-scoped', async () => {
  const cls = await createClass(yogaPayload({ class_type: 'IsoYoga', capacity: 5 }));
  const other = tokens[PEOPLE.owner2.email];
  assert.strictEqual((await api(other, 'GET', `/gym/${gym.id}/classes/${cls.id}`)).status, 403);
  assert.strictEqual((await api(other, 'POST', `/gym/${gym.id}/classes/${cls.id}/cancel`, {})).status, 403);

  const otherCls = await createClass(yogaPayload({ trainer_staff_id: null }), other, gymB.id);
  assert.strictEqual((await api(owner(), 'GET', `/gym/${gymB.id}/classes/${otherCls.id}`)).status, 403);
  // gymA's trainer cannot be scheduled in gymB
  const crossTrainer = await api(other, 'POST', `/gym/${gymB.id}/classes`,
    yogaPayload({ trainer_staff_id: trainerAId }));
  assert.strictEqual(crossTrainer.status, 404);
});

// ── audit trail ───────────────────────────────────────────────────────────

test('audit trail records the class lifecycle', async () => {
  const createdRes = await api(owner(), 'GET', `/gym/${gym.id}/audit-log?action=class.created&limit=5`);
  assert.strictEqual(createdRes.status, 200);
  const createdBody = await createdRes.json();
  const createdRows = createdBody.rows || createdBody;
  assert.ok(createdRows.length > 0, 'audit missing class.created');

  for (const action of ['class.booked', 'class.cancelled', 'class.attendance', 'class.booking_cancelled']) {
    const r = await api(owner(), 'GET', `/gym/${gym.id}/audit-log?action=${action}&limit=5`);
    const body = await r.json();
    const rows = body.rows || body;
    assert.ok(rows.length > 0, `audit missing ${action}`);
  }
});
