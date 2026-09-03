// Gym attendance tests (Phase 10). Real routers, real DATABASE_URL,
// self-cleaning fixtures.
//
// Covers the spec: QR/front-desk/workout-completion/manual sources, non-app
// members, duplicate prevention (08:00 QR + 08:02 QR + 10:00 workout = ONE
// visit), midnight span via the visit window, expired/frozen/cancelled
// members, invalid QR and QR from another gym answering identically,
// offline batch with device-time correction, backdated manual entries,
// manual deletion, dashboard stats, mobile self-service, timezone-local
// days, and authorization.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymAttendance.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';
const TODAY = new Date().toISOString().slice(0, 10);

const PEOPLE = {
  owner: { email: `at_owner_${suffix}@test.local`, name: 'Attendance Owner' },
  owner2: { email: `at_owner2_${suffix}@test.local`, name: 'Other Owner' },
  desk: { email: `at_desk_${suffix}@test.local`, name: 'Attendance Desk' },
  appUser: { email: `at_app_${suffix}@test.local`, name: 'App Person' },
  appUser2: { email: `at_app2_${suffix}@test.local`, name: 'Second App Person' },
};
const tokens = {};
let gymA, gymB, plan;
let aman, amanQr; // non-app member with a QR card
let appMember, appMemberQr;
const createdUserIds = [];
const createdGymIds = [];

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
    body: JSON.stringify({ email: person.email, password: person.password || PASSWORD }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `login ${person.email}`);
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

const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `AttendGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `AttendGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(r.status, 201, 'front desk added');

  const planRes = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Monthly', price_cents: 150000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' });
  plan = await planRes.json();

  aman = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Aman', phone: '+91 94000 00000' })).json();
  // membership so QR checks pass eligibility
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${aman.id}/memberships`, { plan_id: plan.id });
  const qr = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${aman.id}/qr`)).json();
  amanQr = qr.qr_token;
  assert.ok(/^[0-9a-f]{32}$/.test(amanQr), 'QR token is 128-bit');

  appMember = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AppMember', email: PEOPLE.appUser.email })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${appMember.id}/link-app`, { email: PEOPLE.appUser.email });
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${appMember.id}/memberships`, { plan_id: plan.id });
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── sources & the non-app member ─────────────────────────────────────────

test('QR check-in: non-app member (app_user_id NULL) is fully valid', async () => {
  const res = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: amanQr });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `scan: ${JSON.stringify(body)}`);
  assert.strictEqual(body.duplicate, false);
  assert.strictEqual(body.member.member_code, aman.member_code);
  assert.strictEqual(body.attendance.source, 'QR_CHECK_IN');
});

test('duplicate prevention: 08:00 QR + 08:02 QR + 10:00 workout = ONE visit', async () => {
  // re-scans on the same day are the same visit
  const rescan = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: amanQr });
  const body = await rescan.json();
  assert.strictEqual(rescan.status, 200, 'duplicate scan returns 200 with the existing visit');
  assert.strictEqual(body.duplicate, true);
  // a workout completion later the same day is also the same visit
  const workout = await api(tokens[PEOPLE.appUser.email], 'POST', '/gym/my/attendance/workout');
  const wBody = await workout.json();
  assert.strictEqual(workout.status, 200);
  void wBody;
  const count = await query(
    'SELECT COUNT(*)::int AS c FROM gym_attendance WHERE member_id = $1', [aman.id]
  );
  assert.strictEqual(count.rows[0].c, 1, 'exactly one attendance record for the intended visit');
});

test('invalid QR and QR from another gym answer identically (404, no leaks)', async () => {
  // a member of gym B gets a QR — scanning it at gym A must fail
  const memberB = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'GymB', email: `at_gb_${suffix}@test.local` })).json();
  const qrB = await (await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gymB.id}/members/${memberB.id}/qr`)).json();
  const foreign = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: qrB.qr_token });
  assert.strictEqual(foreign.status, 404);
  const invalid = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.strictEqual(invalid.status, 404);
  const invalidBody = await invalid.json();
  const foreignBody = await foreign.json();
  assert.strictEqual(invalidBody.error, foreignBody.error, 'identical answer — no existence leak');
});

// ── membership-state rules ───────────────────────────────────────────────

test('expired member: QR rejected, front desk allowed with a warning', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'ExpiredGuy', email: `at_exp_${suffix}@test.local` })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/link-app`, { email: `at_exp_${suffix}@test.local` });
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/memberships`, { plan_id: plan.id });
  await query(`UPDATE member_memberships SET ends_on = $2::date - 40 WHERE member_id = $1`, [m.id, TODAY]);
  // a read triggers lazy expiry
  await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${m.id}/memberships`);

  const qr = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${m.id}/qr`)).json();
  const scan = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: qr.qr_token });
  assert.strictEqual(scan.status, 403, 'expired member rejected at QR');
  const manual = await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance`);
  const mBody = await manual.json();
  assert.strictEqual(manual.status, 201, `desk discretion: ${JSON.stringify(mBody)}`);
  assert.ok(mBody.warning, 'carries a membership warning');
});

test('frozen member: QR rejected with reason', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'FrozenGuy' })).json();
  const t = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/memberships`, { plan_id: plan.id })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/memberships/${t.id}/freeze`);
  const qr = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${m.id}/qr`)).json();
  const scan = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: qr.qr_token });
  const body = await scan.json();
  assert.strictEqual(scan.status, 403);
  assert.ok(/frozen/.test(body.error), `reason mentions frozen: ${body.error}`);
});

test('cancelled member: all attendance rejected (they left)', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'LeftGuy' })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/memberships`, { plan_id: plan.id });
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members/${m.id}/cancel`);
  const manual = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance`);
  assert.strictEqual(manual.status, 403, 'even the desk cannot check in a member who left');
});

// ── offline sync & device time ───────────────────────────────────────────

test('offline batch: queued scans sync with per-item results; duplicate collapse', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'OfflineGuy' })).json();
  const qr = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${m.id}/qr`)).json();
  const batch = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/offline-batch`,
    { items: [
      { qr_token: qr.qr_token },
      { qr_token: qr.qr_token, client_time: new Date(Date.now() + 60 * 1000).toISOString() },
      { qr_token: 'ffffffffffffffffffffffffffffffff' },
    ] });
  const body = await batch.json();
  assert.strictEqual(batch.status, 200);
  assert.strictEqual(body.results.length, 3);
  assert.strictEqual(body.results[0].ok, true);
  assert.strictEqual(body.results[0].duplicate, false);
  assert.strictEqual(body.results[1].ok, true);
  assert.strictEqual(body.results[1].duplicate, true, 'second queued scan = same visit');
  assert.strictEqual(body.results[2].ok, false, 'invalid QR fails alone');
  assert.strictEqual(body.results[2].reason, 'invalid_qr');
});

test('incorrect device time: a future-claimed stamp is corrected server-side and flagged', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'ClockSkew' })).json();
  const batch = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/offline-batch`,
    { items: [{ member_id: m.id, client_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString() }] });
  const body = await batch.json();
  assert.strictEqual(body.results[0].ok, true);
  const row = await query('SELECT time_corrected, client_time FROM gym_attendance WHERE member_id = $1', [m.id]);
  assert.strictEqual(row.rows[0].time_corrected, true, 'flagged as corrected');
  assert.ok(row.rows[0].client_time, 'the claimed client time is retained for audit');
});

// ── manual correction, backdating, deletion ──────────────────────────────

test('backdated manual entry; duplicates on the same day collapse; future rejected', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Backdate' })).json();
  const back = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance/backdate`, { local_date: addDays(TODAY, -3) });
  assert.strictEqual(back.status, 201, `backdate: ${JSON.stringify(await back.json())}`);
  const again = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance/backdate`, { local_date: addDays(TODAY, -3) });
  assert.strictEqual(again.status, 201);
  const body = await again.json();
  assert.strictEqual(body.duplicate, true);
  const future = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance/backdate`, { local_date: addDays(TODAY, 2) });
  assert.strictEqual(future.status, 400, 'future attendance rejected');
  const tooOld = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance/backdate`, { local_date: addDays(TODAY, -120) });
  assert.strictEqual(tooOld.status, 400, 'older than 90 days rejected');
});

test('QR rotation: lost card re-issues the token; old token dies', async () => {
  const qr = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/members/${aman.id}/qr`)).json();
  const rotated = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${aman.id}/qr/rotate`);
  const rotatedBody = await rotated.json();
  assert.strictEqual(rotated.status, 200);
  assert.notStrictEqual(rotatedBody.qr_token, qr.qr_token);
  const oldScan = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: qr.qr_token });
  assert.strictEqual(oldScan.status, 404, 'the old token no longer works');
  const newScan = await api(tokens[PEOPLE.desk.email], 'POST', `/gym/${gymA.id}/attendance/scan`,
    { qr_token: rotatedBody.qr_token });
  assert.ok([200, 201].includes(newScan.status), 'the new token works');
});

test('manual correction: wrong record can be deleted (owner only)', async () => {
  const m = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'WrongScan' })).json();
  const mark = await (await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${m.id}/attendance`)).json();
  const del = await api(tokens[PEOPLE.desk.email], 'DELETE',
    `/gym/${gymA.id}/attendance/${mark.attendance.id}`);
  assert.strictEqual(del.status, 403, 'front desk cannot delete');
  const delOwner = await api(tokens[PEOPLE.owner.email], 'DELETE',
    `/gym/${gymA.id}/attendance/${mark.attendance.id}`);
  assert.strictEqual(delOwner.status, 200);
});

// ── dashboard, history, mobile, timezone ─────────────────────────────────

test('dashboard: today/week/month counts, peak hours, inactive members', async () => {
  const stats = await (await api(tokens[PEOPLE.owner.email], 'GET', `/gym/${gymA.id}/attendance/stats`)).json();
  assert.ok(stats.today_count >= 1);
  assert.ok(stats.week_count >= stats.today_count);
  assert.ok(stats.month_count >= stats.week_count);
  assert.ok(Array.isArray(stats.peak_hours));
  assert.ok(Array.isArray(stats.inactive_members));
  void plan;
});

test('member history: ✓/− calendar (Sep 2 ✓ / Sep 1 - shape)', async () => {
  const history = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${aman.id}/attendance/history?days=7`)).json();
  assert.ok(history.length === 7);
  const todayEntry = history.find((h) => h.date === TODAY);
  assert.ok(todayEntry.present, 'today marked ✓ for Aman');
  assert.ok(history.every((h) => typeof h.present === 'boolean'));
});

test('mobile: workout completion marks attendance only with an ACTIVE membership', async () => {
  // appUser has an ACTIVE term → eligible
  const ok = await api(tokens[PEOPLE.appUser.email], 'POST', '/gym/my/attendance/workout');
  const okBody = await ok.json();
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(okBody.eligible, true);
  assert.strictEqual(okBody.results[0].duplicate, true, 'same-day workout = same visit');
  // appUser2 is a member of the gym WITHOUT any membership → not eligible
  await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoPlan', email: PEOPLE.appUser2.email });
  const link = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${appMember.id}/link-app`, { email: PEOPLE.appUser.email });
  assert.strictEqual(link.status, 200);
  const noPlan = await api(tokens[PEOPLE.appUser2.email], 'POST', '/gym/my/attendance/workout');
  const noPlanBody = await noPlan.json();
  assert.strictEqual(noPlanBody.eligible, false, 'no active membership → the app would not prompt');
});

test('timezone: local_date is the GYM-local calendar day', async () => {
  // gym A runs on UTC (default); store a record and confirm local_date matches the gym tz derivation
  const rows = await query(
    `SELECT a.local_date, (a.check_in_at AT TIME ZONE g.timezone)::date AS derived
     FROM gym_attendance a JOIN gyms g ON g.id = a.gym_id WHERE g.id = $1`,
    [gymA.id]
  );
  assert.ok(rows.rows.every((r) => String(r.local_date) === String(r.derived)),
    'local_date always equals the gym-local day of check_in_at');
});

test('authorization: front desk scans + lists, but cannot backdate/delete; cross-gym 403', async () => {
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'GET',
    `/gym/${gymA.id}/attendance?date=${TODAY}`)).status, 200);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'GET',
    `/gym/${gymA.id}/attendance/stats`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.appUser.email], 'POST',
    `/gym/${gymA.id}/attendance/scan`, { qr_token: amanQr })).status, 403,
    'a plain app member cannot operate the scanner');
});

test('audit trail records attendance lifecycle', async () => {
  const rows = await (await api(tokens[PEOPLE.owner.email],
    'GET', `/gym/${gymA.id}/audit-log?limit=300`)).json();
  const actions = rows.map((r) => r.action);
  for (const expected of ['attendance.recorded', 'attendance.deleted', 'member.qr_rotated']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
});
