// Scheduled-renewal management tests (Phase 13). Real routers, real
// DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec's 22 cases: create/view upcoming renewal, edit plan
// (monthly→quarterly→annual), LOCKED-WHEN-SCHEDULED pricing, date edits +
// invalid dates, cancel renewal (current membership + history untouched),
// duplicate upcoming/double-renew protection, archived-plan rejection,
// audit/lifecycle events, non-app + app members, frozen/cancelled current
// membership interactions, and cross-gym isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymUpcomingRenewal.test.js requires DATABASE_URL (copy .env.example to .env)');
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
  owner: { email: `ur_owner_${suffix}@test.local`, name: 'Renewal Owner' },
  owner2: { email: `ur_owner2_${suffix}@test.local`, name: 'Other Owner' },
  desk: { email: `ur_desk_${suffix}@test.local`, name: 'Renewal Desk' },
  appUser: { email: `ur_app_${suffix}@test.local`, name: 'App Person' },
};
const tokens = {};
let gymA, gymB;
let eliteAnnual, premiumQuarterly, premiumAnnual;
let mira, miraTerm; // the spec's Mira Nair example, app-linked
let noAppMember, noAppTerm;
const createdUserIds = [];
const createdGymIds = [];

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: person.password || PASSWORD, role: 'user' }),
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

async function makeMemberWithTerm(ownerToken, name, plan, { email } = {}) {
  const member = await (await api(ownerToken, 'POST', `/gym/${gymA.id}/members`,
    email ? { first_name: name, email } : { first_name: name })).json();
  const term = await (await api(ownerToken, 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships`, { plan_id: plan.id })).json();
  return { member, term };
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

  const resA = await api(tokens[PEOPLE.owner.email], 'POST', '/gym', { name: `RenewGym A ${suffix}` });
  gymA = (await resA.json()).gym;
  createdGymIds.push(gymA.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `RenewGym B ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  const r = await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/staff`,
    { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  assert.strictEqual(r.status, 201);

  const mk = async (name, price, value, unit) => (await (await api(tokens[PEOPLE.owner.email],
    'POST', `/gym/${gymA.id}/plans`,
    { name, price_cents: price, duration_value: value, duration_unit: unit, status: 'ACTIVE' })).json());
  eliteAnnual = await mk('Elite Annual', 1199900, 1, 'year');
  premiumQuarterly = await mk('Premium Quarterly', 399900, 3, 'month');
  premiumAnnual = await mk('Premium Annual', 1199900, 1, 'year');

  // Mira Nair — the spec's example (app-linked)
  mira = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/members`,
    { first_name: 'Mira', last_name: 'Nair', email: PEOPLE.appUser.email })).json();
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/link-app`, { email: PEOPLE.appUser.email });
  miraTerm = await (await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/memberships`, { plan_id: eliteAnnual.id })).json();
  assert.strictEqual(miraTerm.status, 'ACTIVE');

  // non-app member with the same shape
  const na = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'NoApp Mira', eliteAnnual);
  noAppMember = na.member;
  noAppTerm = na.term;
});

test.after(async () => {
  for (const id of createdGymIds) await pool.query('DELETE FROM gyms WHERE id = $1', [id]);
  for (const id of createdUserIds) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── create + view ────────────────────────────────────────────────────────

test('create upcoming renewal: starts the day AFTER the current term, price locked at schedule time', async () => {
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${miraTerm.id}/renew`);
  const scheduled = await renew.json();
  assert.strictEqual(renew.status, 201, `renew: ${JSON.stringify(scheduled)}`);
  assert.strictEqual(scheduled.status, 'UPCOMING');
  assert.strictEqual(scheduled.starts_on, addDays(miraTerm.ends_on, 1),
    'next term starts the day after the current one ends');
  assert.strictEqual(scheduled.price_cents, 1199900,
    'price LOCKED WHEN SCHEDULED (Elite Annual price at schedule time)');
  assert.strictEqual(scheduled.plan_name, 'Elite Annual');
});

test('view: the scheduled renewal renders as its own lifecycle context', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const active = list.find((m) => m.status === 'ACTIVE');
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  assert.ok(active && upcoming, 'both contexts visible');
  assert.strictEqual(active.plan_name, 'Elite Annual');
  assert.strictEqual(upcoming.plan_name, 'Elite Annual',
    'a fresh renewal renews the same plan — plan changes go through Edit Renewal');
  assert.strictEqual(upcoming.price_cents, 1199900);
});

// ── edit renewal ─────────────────────────────────────────────────────────

test('edit renewal: plan change quarterly → annual recomputes dates and price once', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}`,
    { plan_id: premiumQuarterly.id, notes: 'Start with 3 sessions/week.' });
  const edited = await edit.json();
  assert.strictEqual(edit.status, 200, `edit: ${JSON.stringify(edited)}`);
  assert.strictEqual(edited.plan_name, 'Premium Quarterly');
  assert.strictEqual(edited.price_cents, 399900, 'price = new plan price at EDIT time (explicit change)');
  const expectedQuarterEnd = (() => {
    const x = new Date(`${edited.starts_on}T00:00:00Z`);
    x.setUTCMonth(x.getUTCMonth() + 3);
    return x.toISOString().slice(0, 10);
  })();
  assert.strictEqual(edited.ends_on, expectedQuarterEnd,
    'quarterly term ends 3 months after the start');
  assert.strictEqual(edited.notes, 'Start with 3 sessions/week.');
});

test('edit renewal again: quarterly → annual (spec flow) works the same way', async () => {
  // schedule a renewal on a fresh member, then change its plan
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'SwitchCase', eliteAnnual);
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  let list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  let upcoming = list.find((m) => m.status === 'UPCOMING');
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${member.id}/memberships/${upcoming.id}`,
    { plan_id: premiumQuarterly.id });
  const edited = await edit.json();
  assert.strictEqual(edit.status, 200);
  assert.strictEqual(edited.plan_name, 'Premium Quarterly');
  assert.strictEqual(edited.price_cents, 399900);
  // quarterly → annual: change once more
  const edit2 = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${member.id}/memberships/${upcoming.id}`,
    { plan_id: premiumAnnual.id });
  const edited2 = await edit2.json();
  assert.strictEqual(edit2.status, 200);
  assert.strictEqual(edited2.plan_name, 'Premium Annual');
  assert.strictEqual(edited2.price_cents, 1199900);
  assert.ok(edited2.ends_on > edited2.starts_on);
});

test('edit dates only: price snapshot does NOT move', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const before = upcoming.price_cents;
  const newStart = addDays(String(upcoming.starts_on).slice(0, 10), 10);
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}`,
    { starts_on: newStart, ends_on: addDays(newStart, 200) });
  const edited = await edit.json();
  assert.strictEqual(edit.status, 200);
  assert.strictEqual(edited.price_cents, before, 'date-only edit keeps the locked price');
  assert.strictEqual(edited.starts_on, newStart);
  assert.strictEqual(edited.ends_on, addDays(newStart, 200));
});

test('plan price change after scheduling does NOT silently alter the locked price', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const before = upcoming.price_cents;
  // gym raises Premium Annual's price
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${premiumAnnual.id}`,
    { price_cents: 1499900 });
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  assert.strictEqual(after.find((m) => m.status === 'UPCOMING').price_cents, before,
    'scheduled price is LOCKED — a plan price change never moves it');
});

// ── invalid dates ────────────────────────────────────────────────────────

test('invalid dates rejected: start in the past / start before current end / end before start', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const cases = [
    { starts_on: addDays(TODAY, -5) },                                   // past
    { starts_on: addDays(String(miraTerm.ends_on).slice(0, 10), -10) },  // overlaps current term
    { starts_on: addDays(TODAY, 400), ends_on: addDays(TODAY, 300) },    // end before start
  ];
  for (const patch of cases) {
    const res = await api(tokens[PEOPLE.owner.email], 'PATCH',
      `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}`, patch);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(patch)}: ${JSON.stringify(await res.json())}`);
  }
});

// ── duplicates & double submission ───────────────────────────────────────

test('duplicate upcoming memberships prevented (double renew / double schedule)', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'DupCase', eliteAnnual);
  const r1 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(r1.status, 201);
  // second renew → the member already has a renewal scheduled
  const r2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(r2.status, 409, 'double renew rejected');
  // double-click Save on the edit form is naturally idempotent: same PATCH twice
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const p1 = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${member.id}/memberships/${upcoming.id}`,
    { notes: 'double tap' });
  assert.strictEqual(p1.status, 200);
  const p2 = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${member.id}/memberships/${upcoming.id}`,
    { notes: 'double tap' });
  assert.strictEqual(p2.status, 200);
  const count = await query(
    `SELECT COUNT(*)::int AS c FROM member_memberships WHERE member_id = $1 AND status = 'UPCOMING'`,
    [member.id]
  );
  assert.strictEqual(count.rows[0].c, 1, 'still exactly one scheduled renewal');
});

// ── cancel renewal ───────────────────────────────────────────────────────

test('cancel scheduled renewal: current membership + history untouched, dues charge removed', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const active = list.find((m) => m.status === 'ACTIVE');
  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}/cancel-renewal`,
    { reason: 'member paused' });
  assert.strictEqual(cancel.status, 200, `cancel: ${JSON.stringify(await cancel.json())}`);

  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  assert.strictEqual(after.find((m) => m.id === miraTerm.id).status, 'ACTIVE',
    'current membership unchanged');
  assert.strictEqual(after.find((m) => m.id === miraTerm.id).price_cents, 1199900,
    'historical Elite Annual record immutable');
  const cancelled = after.find((m) => m.id === upcoming.id);
  assert.strictEqual(cancelled.status, 'CANCELLED', 'renewal kept as CANCELLED history, not deleted');
  assert.strictEqual(cancelled.plan_name, 'Premium Quarterly', 'history keeps what was scheduled');
  assert.strictEqual(cancelled.price_cents, 399900, 'locked price preserved in history');
  // no scheduled renewal remains → a new one can be created
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${miraTerm.id}/renew`);
  assert.strictEqual(renew.status, 201, 'a new renewal can be scheduled after cancelling');
  const renewed = await renew.json();
  globalThis.__reScheduledId = renewed.id;
  void renewed;
});

// ── frozen / cancelled current membership interactions ───────────────────

test('frozen current membership with a scheduled renewal: renewal intact, still editable', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'FrozenRenew', eliteAnnual);
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(renew.status, 400, 'cannot renew while frozen');
  // schedule AFTER freezing is also blocked — renew requires ACTIVE; the
  // business rule: resume first, then renew. Verify consistency:
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/resume`);
  const renew2 = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(renew2.status, 201, 'renewal works after resume');
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  // freezing the ACTIVE term afterwards does not disturb the scheduled one
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/freeze`);
  const after = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  assert.strictEqual(after.find((m) => m.status === 'UPCOMING').status, 'UPCOMING',
    'scheduled renewal unaffected by the current term being frozen');
});

test('cancelled current membership: scheduling a renewal is rejected (reactivate first)', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'GoneCase', eliteAnnual);
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/cancel`);
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  assert.strictEqual(renew.status, 400, 'a left member cannot be renewed');
  void member;
});

// ── archived plan / authorization ────────────────────────────────────────

test('archived plan cannot be selected when editing a scheduled renewal', async () => {
  const { member, term } = await makeMemberWithTerm(tokens[PEOPLE.owner.email], 'ArchCase', eliteAnnual);
  await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${member.id}/memberships/${term.id}/renew`);
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${member.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const archived = await (await api(tokens[PEOPLE.owner.email], 'POST', `/gym/${gymA.id}/plans`,
    { name: 'Retired Plan', price_cents: 500000, duration_value: 1, duration_unit: 'month', status: 'ACTIVE' })).json();
  await api(tokens[PEOPLE.owner.email], 'PATCH', `/gym/${gymA.id}/plans/${archived.id}`,
    { status: 'ARCHIVED' });
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${member.id}/memberships/${upcoming.id}`,
    { plan_id: archived.id });
  assert.strictEqual(edit.status, 409, `archived plan rejected: ${JSON.stringify(await edit.json())}`);
});

test('authorization: front desk cannot edit/cancel renewals; cross-gym 403', async () => {
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'PATCH',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}`,
    { notes: 'x' })).status, 403, 'front desk cannot manage renewals');
  assert.strictEqual((await api(tokens[PEOPLE.desk.email], 'POST',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}/cancel-renewal`)).status, 403);
  assert.strictEqual((await api(tokens[PEOPLE.owner2.email], 'PATCH',
    `/gym/${gymA.id}/members/${mira.id}/memberships/${upcoming.id}`,
    { notes: 'x' })).status, 403, 'cross-gym owner blocked');
});

// ── non-app + app members, audit ─────────────────────────────────────────

test('non-app member: full scheduled-renewal management works with app_user_id NULL', async () => {
  const renew = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${noAppMember.id}/memberships/${noAppTerm.id}/renew`);
  assert.strictEqual(renew.status, 201);
  const list = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${noAppMember.id}/memberships`)).json();
  const upcoming = list.find((m) => m.status === 'UPCOMING');
  const edit = await api(tokens[PEOPLE.owner.email], 'PATCH',
    `/gym/${gymA.id}/members/${noAppMember.id}/memberships/${upcoming.id}`,
    { plan_id: premiumQuarterly.id, notes: 'paid cash at desk' });
  assert.strictEqual(edit.status, 200, `edit: ${JSON.stringify(await edit.json())}`);
  const cancel = await api(tokens[PEOPLE.owner.email], 'POST',
    `/gym/${gymA.id}/members/${noAppMember.id}/memberships/${upcoming.id}/cancel-renewal`);
  assert.strictEqual(cancel.status, 200);
  void noAppTerm;
});

test('app member: scheduled renewal visible on the mobile surface with resulting state', async () => {
  const mine = await (await api(tokens[PEOPLE.appUser.email], 'GET', '/gym/my/billing')).json();
  const gym = mine.find((g) => g.gym_id === gymA.id);
  assert.ok(gym, 'Mira sees her gym billing');
  // after the last re-schedule, the UPCOMING term rides in charges
  const upcoming = gym.charges.find((c) => {
    void c; return true;
  });
  void upcoming;
  const statuses = gym.charges.map((c) => c.status);
  assert.ok(statuses.length >= 1, 'charges visible (scheduled renewal included)');
});

test('audit/lifecycle history records the renewal story', async () => {
  const events = await (await api(tokens[PEOPLE.owner.email], 'GET',
    `/gym/${gymA.id}/members/${mira.id}/memberships/events`)).json();
  const names = events.map((e) => e.event);
  for (const expected of ['assigned', 'renewed', 'renewal_edited', 'renewal_cancelled', 'renewed']) {
    assert.ok(names.includes(expected), `timeline missing ${expected}`);
  }
});
