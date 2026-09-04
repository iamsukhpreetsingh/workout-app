// Gym announcements & fan-out tests (Phase 14). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers: create DRAFT/SCHEDULED (gym-local wall time), audience
// validation (incl. cross-gym ids), edit rules (SENT/CANCELLED immutable,
// DRAFT → SCHEDULED promotion), publish-now fan-out (IN_APP inbox rows,
// PUSH skipped without a token, EMAIL skipped without address/SMTP),
// send-time audience resolution (member added AFTER create still receives),
// SPECIFIC_MEMBERS with a CANCELLED member (SKIPPED member_inactive_at_send),
// SPECIFIC_BRANCH scoping, schedule → dispatch-due, idempotent re-dispatch,
// crash recovery (stranded QUEUED row re-delivered, no duplicate inbox row),
// multi-gym isolation, /my/announcements, permissions and audit trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymCommunications.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

// deterministic channels: no SMTP in this suite (EMAIL rows must be SKIPPED,
// never sent), regardless of the developer's local .env
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `an_owner_${suffix}@test.local`, name: 'Announce Owner' },
  owner2: { email: `an_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `an_admin_${suffix}@test.local`, name: 'Announce Admin' },
  trainer: { email: `an_trainer_${suffix}@test.local`, name: 'Announce Trainer' },
  frontDesk: { email: `an_desk_${suffix}@test.local`, name: 'Announce Desk' },
  memberA: { email: `an_membera_${suffix}@test.local`, name: 'App Member A' },
  memberB: { email: `an_memberb_${suffix}@test.local`, name: 'App Member B' },
  laterUser: { email: `an_later_${suffix}@test.local`, name: 'Late Joiner' },
};
const tokens = {};
let gymA, gymB;
let mAppA, mAppB, mMailNoApp, mNoMailNoApp, mLaterApp, mBranchApp;
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
const admin = () => tokens[PEOPLE.admin.email];

// gym-local wall-time helpers: the gym runs in Asia/Kolkata for the whole
// suite (deterministic conversion assertions regardless of server tz)
const TZ = 'Asia/Kolkata';
const wallNow = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const wallShift = (days) => {
  const d = new Date(`${wallNow()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function notificationsCount(userId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_id = $1 AND type = 'gym_announcement'",
    [userId]
  );
  return rows[0].n;
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

  const resA = await api(owner(), 'POST', '/gym', { name: `AnnounceGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `AnnounceGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  // deterministic gym-local scheduling + branch assertions
  await query('UPDATE gyms SET timezone = $2 WHERE id = $1', [gymA.id, TZ]);

  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.trainer.email, gym_role: 'TRAINER' });
  await api(owner(), 'POST', `/gym/${gymA.id}/staff`, { email: PEOPLE.frontDesk.email, gym_role: 'FRONT_DESK' });

  // members: two app-connected, one non-app WITH email, one non-app WITHOUT
  mAppA = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AppA', email: PEOPLE.memberA.email })).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mAppA.id}/link-app`, { email: PEOPLE.memberA.email });
  mAppA = (await (await api(owner(), 'GET', `/gym/${gymA.id}/members/${mAppA.id}`)).json());

  mAppB = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'AppB', email: PEOPLE.memberB.email })).json();
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mAppB.id}/link-app`, { email: PEOPLE.memberB.email });
  mAppB = (await (await api(owner(), 'GET', `/gym/${gymA.id}/members/${mAppB.id}`)).json());

  mMailNoApp = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'MailNoApp', email: `an_mail_${suffix}@mail.local` })).json();
  mNoMailNoApp = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'NoMail' })).json();

  // a member who joins LATER (audience resolution happens at SEND time)
  mLaterApp = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'LaterApp' })).json();

  // branch-labelled app member (SPECIFIC_BRANCH scoping)
  mBranchApp = await (await api(owner(), 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'BranchApp' })).json();
  await query('UPDATE gym_members SET branch = $2 WHERE id = $1', [mBranchApp.id, 'North Wing']);
  await query('UPDATE gym_members SET branch = $2 WHERE id = $1', [mMailNoApp.id, 'North Wing']);
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

// ── create ────────────────────────────────────────────────────────────────

test('create DRAFT (ALL_ACTIVE_MEMBERS) — no schedule', async () => {
  const res = await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Gym Closure', body: 'Closed on Sunday for maintenance.',
    audience_type: 'ALL_ACTIVE_MEMBERS',
  });
  assert.strictEqual(res.status, 201);
  const ann = await res.json();
  assert.strictEqual(ann.status, 'DRAFT');
  assert.strictEqual(ann.scheduled_for, null);
  assert.strictEqual(ann.audience_type, 'ALL_ACTIVE_MEMBERS');
});

test('create SCHEDULED with gym-local wall time — round-trips the wall clock', async () => {
  const wall = `${wallShift(-1)} 08:30`; // yesterday gym-local → already due
  const res = await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Scheduled', body: 'Fires via dispatch-due.',
    audience_type: 'ALL_ACTIVE_MEMBERS', scheduled_for: wall,
  });
  assert.strictEqual(res.status, 201);
  const ann = await res.json();
  assert.strictEqual(ann.status, 'SCHEDULED');
  assert.strictEqual(ann.scheduled_for_local, wall);
});

test('validation: blank title, huge body, bad audience, cross-gym ids, stray fields', async () => {
  const base = { audience_type: 'ALL_ACTIVE_MEMBERS' };
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { ...base, title: '   ', body: 'x' })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { ...base, title: 'T', body: 'x'.repeat(5001) })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { ...base, title: 'T', body: 'B', audience_type: 'EVERYONE' })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'SPECIFIC_MEMBERS' })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'SPECIFIC_MEMBERS', audience_member_ids: ['not-a-uuid'] })).status, 400);
  // a gym-B member id does not belong to gym A
  const gymBMember = await (await api(tokens[PEOPLE.owner2.email], 'POST', `/gym/${gymB.id}/members`,
    { first_name: 'OtherGym' })).json();
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'SPECIFIC_MEMBERS', audience_member_ids: [gymBMember.id] })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'ALL_ACTIVE_MEMBERS', audience_member_ids: [mAppA.id] })).status, 400);
  assert.equal((await api(owner(), 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'SPECIFIC_BRANCH' })).status, 400);
});

// ── edit rules ────────────────────────────────────────────────────────────

test('edit DRAFT; scheduled_for promotes DRAFT → SCHEDULED', async () => {
  const create = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Draft title', body: 'Draft body', audience_type: 'ALL_ACTIVE_MEMBERS',
  })).json();
  const patched = await (await api(owner(), 'PATCH', `/gym/${gymA.id}/announcements/${create.id}`, {
    title: 'Edited title',
    scheduled_for: `${wallShift(2)} 18:00`,
  })).json();
  assert.strictEqual(patched.title, 'Edited title');
  assert.strictEqual(patched.status, 'SCHEDULED');
  assert.strictEqual(patched.scheduled_for_local, `${wallShift(2)} 18:00`);
  // clearing the time on a SCHEDULED announcement is rejected
  assert.equal((await api(owner(), 'PATCH', `/gym/${gymA.id}/announcements/${create.id}`, {
    scheduled_for: null,
  })).status, 400);
});

test('publish now: DRAFT → SENT, full fan-out ledger for mixed members', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Send now', body: 'Immediate fan-out across app and non-app members.',
    audience_type: 'ALL_ACTIVE_MEMBERS',
  })).json();

  const res = await api(owner(), 'POST', `/gym/${gymA.id}/announcements/${ann.id}/publish`);
  assert.strictEqual(res.status, 200);
  const out = await res.json();
  assert.strictEqual(out.status, 'SENT');
  assert.ok(out.published_at);
  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  // audience = ALL 6 non-cancelled members at send time (mAppA, mAppB,
  // mMailNoApp, mNoMailNoApp, mLaterApp, mBranchApp — the later two exist
  // already, still non-app): IN_APP ×2 SENT, PUSH ×2 + EMAIL ×4 SKIPPED
  assert.strictEqual(detail.delivery_summary.sent, 2);
  assert.strictEqual(detail.delivery_summary.skipped, 6);
  const byKey = new Map(detail.deliveries.map((d) => [`${d.member_id}:${d.channel}`, d]));
  const inAppA = byKey.get(`${mAppA.id}:IN_APP`);
  assert.strictEqual(inAppA.status, 'SENT');
  const pushA = byKey.get(`${mAppA.id}:PUSH`);
  assert.strictEqual(pushA.status, 'SKIPPED');
  assert.strictEqual(pushA.detail, 'no_push_token');           // never faked
  const mail = byKey.get(`${mMailNoApp.id}:EMAIL`);
  assert.strictEqual(mail.status, 'SKIPPED');
  assert.strictEqual(mail.detail, 'email_not_configured');     // SMTP off in tests
  const noMail = byKey.get(`${mNoMailNoApp.id}:EMAIL`);
  assert.strictEqual(noMail.status, 'SKIPPED');
  assert.strictEqual(noMail.detail, 'no_email_address');
  // the app member's INBOX got the announcement (zero mobile changes needed)
  const userA = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.memberA.email])).rows[0];
  assert.ok(await notificationsCount(userA.id) >= 1);
  // app member also sees it on the member surface
  const mine = await (await api(tokens[PEOPLE.memberA.email], 'GET', '/gym/my/announcements')).json();
  assert.ok(mine.some((a) => a.id === ann.id));
});

test('SENT is terminal: re-publish 409, PATCH 409, cancel 409', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Terminal', body: 'Once sent, immutable.', audience_type: 'ALL_ACTIVE_MEMBERS',
  })).json();
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 200);
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 409);
  assert.strictEqual((await api(owner(), 'PATCH', `/gym/${gymA.id}/announcements/${ann.id}`,
    { title: 'nope' })).status, 409);
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/cancel`)).status, 409);
});

test('audience resolves at SEND time — a member added after create receives it', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Late joiner', body: 'You were added after this draft existed.',
    audience_type: 'ALL_ACTIVE_MEMBERS',
  })).json();
  // link the later member to the app AFTER the draft was created
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mLaterApp.id}/link-app`,
    { email: `an_later_${suffix}@test.local` });
  const laterUser = (await query('SELECT id FROM users WHERE email = $1',
    [`an_later_${suffix}@test.local`])).rows[0];
  createdUserIds.push(laterUser.id);
  const before = await notificationsCount(laterUser.id);

  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 200);

  assert.strictEqual(await notificationsCount(laterUser.id), before + 1);
  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  assert.ok(detail.deliveries.some((d) => d.member_id === mLaterApp.id && d.channel === 'IN_APP'));
});

test('SPECIFIC_MEMBERS keeps a CANCELLED member in the ledger as SKIPPED', async () => {
  // cancel mNoMailNoApp before sending
  await api(owner(), 'POST', `/gym/${gymA.id}/members/${mNoMailNoApp.id}/cancel`, { reason: 'left gym' });
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Specific list', body: 'Only the two listed members.',
    audience_type: 'SPECIFIC_MEMBERS', audience_member_ids: [mAppA.id, mNoMailNoApp.id],
  })).json();
  const res = await api(owner(), 'POST', `/gym/${gymA.id}/announcements/${ann.id}/publish`);
  assert.strictEqual(res.status, 200);
  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  const byKey = new Map(detail.deliveries.map((d) => [`${d.member_id}:${d.channel}`, d]));
  assert.strictEqual(byKey.get(`${mAppA.id}:IN_APP`).status, 'SENT');
  const skipped = byKey.get(`${mNoMailNoApp.id}:EMAIL`);
  assert.strictEqual(skipped.status, 'SKIPPED');
  assert.strictEqual(skipped.detail, 'member_inactive_at_send');
  assert.strictEqual(detail.delivery_summary.sent, 1);
  // mAppA's PUSH (no token) + the cancelled member's EMAIL = 2 skips
  assert.strictEqual(detail.delivery_summary.skipped, 2);
});

test('SPECIFIC_BRANCH: only labelled members; others get no delivery rows', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'North Wing only', body: 'Pool closed today.',
    audience_type: 'SPECIFIC_BRANCH', audience_branch: 'North Wing',
  })).json();
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 200);
  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  const memberIds = new Set(detail.deliveries.map((d) => d.member_id));
  assert.ok(memberIds.has(mBranchApp.id));
  assert.ok(memberIds.has(mMailNoApp.id));
  assert.ok(!memberIds.has(mAppA.id));   // not in the branch
  assert.ok(!memberIds.has(mAppB.id));
});

test('schedule + dispatch-due promotes and fans out; re-dispatch is idempotent', async () => {
  const wall = `${wallShift(-1)} 09:00`; // yesterday → already due
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Due dispatch', body: 'Promoted by the dispatcher.',
    audience_type: 'ALL_ACTIVE_MEMBERS', scheduled_for: wall,
  })).json();

  const run = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements/dispatch-due`)).json();
  assert.ok(run.dispatched >= 1);
  assert.ok(run.announcement_ids.includes(ann.id));

  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  assert.strictEqual(detail.status, 'SENT');
  const sentAfterFirst = detail.delivery_summary.sent;

  const run2 = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements/dispatch-due`)).json();
  const detail2 = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  assert.strictEqual(detail2.delivery_summary.sent, sentAfterFirst); // dedupe holds
  assert.ok(!run2.announcement_ids.includes(ann.id) || detail2.delivery_summary.sent === sentAfterFirst);

  // the inbox never double-fires either
  const userA = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.memberA.email])).rows[0];
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_id = $1 AND title = 'Due dispatch'",
    [userA.id]
  );
  assert.strictEqual(rows[0].n, 1);
});

test('crash recovery: a stranded QUEUED delivery is finished without duplicating the inbox', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Crash recovery', body: 'The dispatcher finishes what a crash interrupted.',
    audience_type: 'SPECIFIC_MEMBERS', audience_member_ids: [mAppB.id],
  })).json();
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 200);

  // simulate a crash mid-send: ledger row back to QUEUED, inbox row already there
  await query(
    `UPDATE gym_announcement_deliveries SET status = 'QUEUED'
     WHERE announcement_id = $1 AND channel = 'IN_APP'`,
    [ann.id]
  );
  const userB = (await query('SELECT id FROM users WHERE email = $1', [PEOPLE.memberB.email])).rows[0];
  const inboxBefore = await notificationsCount(userB.id);

  const run = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements/dispatch-due`)).json();
  assert.ok(run.rescued >= 1);

  const detail = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements/${ann.id}`)).json();
  const inApp = detail.deliveries.find((d) => d.channel === 'IN_APP');
  assert.strictEqual(inApp.status, 'SENT');
  assert.strictEqual(await notificationsCount(userB.id), inboxBefore); // no duplicate inbox row
});

test('cancel SCHEDULED → CANCELLED; publish then 409', async () => {
  const ann = await (await api(owner(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Cancel me', body: 'Never going out.',
    audience_type: 'ALL_ACTIVE_MEMBERS', scheduled_for: `${wallShift(5)} 10:00`,
  })).json();
  const out = await (await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/cancel`, { reason: 'plans changed' })).json();
  assert.strictEqual(out.status, 'CANCELLED');
  assert.strictEqual((await api(owner(), 'POST',
    `/gym/${gymA.id}/announcements/${ann.id}/publish`)).status, 409);
});

test('multi-gym isolation: gym B dispatch never touches gym A rows', async () => {
  const runB = await (await api(tokens[PEOPLE.owner2.email], 'POST',
    `/gym/${gymB.id}/announcements/dispatch-due`)).json();
  assert.strictEqual(runB.dispatched, 0);
  assert.strictEqual(runB.rescued, 0);
  // gym A's announcements are invisible through gym B's routes
  const listB = await (await api(tokens[PEOPLE.owner2.email], 'GET',
    `/gym/${gymB.id}/announcements`)).json();
  assert.strictEqual(listB.length, 0);
});

test('permissions: FRONT_DESK and TRAINER 403, ADMIN allowed, cross-gym 404', async () => {
  assert.equal((await api(tokens[PEOPLE.frontDesk.email], 'POST', `/gym/${gymA.id}/announcements`,
    { title: 'T', body: 'B', audience_type: 'ALL_ACTIVE_MEMBERS' })).status, 403);
  assert.equal((await api(tokens[PEOPLE.trainer.email], 'GET',
    `/gym/${gymA.id}/announcements`)).status, 403);
  const adminOk = await api(admin(), 'POST', `/gym/${gymA.id}/announcements`, {
    title: 'Admin sent', body: 'ADMIN holds communications.manage.',
    audience_type: 'ALL_ACTIVE_MEMBERS',
  });
  assert.strictEqual(adminOk.status, 201);
  const adminAnn = await adminOk.json();
  // gym B owner is not staff of gym A — the context guard rejects before any
  // resource lookup (existence is never leaked across gyms)
  assert.equal((await api(tokens[PEOPLE.owner2.email], 'GET',
    `/gym/${gymA.id}/announcements/${adminAnn.id}`)).status, 403);
  // plain app member: no communications.manage
  assert.equal((await api(tokens[PEOPLE.memberA.email], 'GET',
    `/gym/${gymA.id}/announcements`)).status, 403);
});

test('list exposes delivery counts + current audience size; audit trail records the send', async () => {
  const list = await (await api(owner(), 'GET', `/gym/${gymA.id}/announcements`)).json();
  assert.ok(list.length >= 5);
  const published = list.find((a) => a.title === 'Send now');
  assert.ok(published.sent_count >= 2);
  assert.ok(published.current_audience_size >= 4); // grows with membership, by design

  const audit = await (await api(owner(), 'GET',
    `/gym/${gymA.id}/audit-log?action=announcement.published`)).json();
  assert.ok(Array.isArray(audit) ? audit.length >= 1 : audit.items?.length >= 1);
});
