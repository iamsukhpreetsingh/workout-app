// membershipPlans.js — plan definitions and per-member memberships (Phase 6).
//
// RULES:
//  - Plans belong to a gym; duplicate names within a gym are rejected.
//  - member_memberships SNAPSHOTS plan name/price/currency/duration at
//    assignment (and again at renewal) — later plan edits or archiving
//    never rewrite history. Nothing here is ever DELETEd.
//  - Only ACTIVE plans can be assigned; ARCHIVED plans cannot be assigned
//    to new members but every existing membership stays valid.
//  - One ACTIVE (and at most one UPCOMING renewal) per member, enforced by
//    partial unique indexes and re-checked inside transactions.
//  - works identically for members with and without app accounts — nothing
//    in this module ever touches app_user_id.
const { query, transaction } = require('../db/pool');
const billing = require('./gymBilling');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── lifecycle helpers (Phase 7) ──────────────────────────────────────────

// Append-only lifecycle timeline — called inside the SAME transaction as
// every status transition, so a status change is never a bare overwrite.
async function recordEvent(client, gymId, membershipId, event, { details, actor } = {}) {
  await client.query(
    `INSERT INTO membership_events (gym_id, membership_id, event, occurred_on, details, actor_user_id)
     VALUES ($1,$2,$3,(now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date,$4,$5)`,
    [gymId, membershipId, event, details ? JSON.stringify(details) : '{}', actor?.userId ?? actor ?? null]
  );
}

// Lazy, idempotent maintenance evaluated in the GYM's timezone: expire
// overdue ACTIVE terms (FROZEN never auto-expires — the freeze pauses the
// clock), then promote UPCOMING terms whose start date has arrived. Runs
// before reads and inside lifecycle transactions.
async function runMembershipMaintenance(client, gymId) {
  const expired = await client.query(
    `UPDATE member_memberships mm SET status = 'EXPIRED', updated_at = now()
     FROM gyms g
     WHERE mm.gym_id = $1 AND g.id = mm.gym_id AND mm.status = 'ACTIVE'
       AND mm.ends_on < (now() AT TIME ZONE g.timezone)::date
     RETURNING mm.id`,
    [gymId]
  );
  for (const row of expired.rows) await recordEvent(client, gymId, row.id, 'expired', {});
  const promoted = await client.query(
    `UPDATE member_memberships mm SET status = 'ACTIVE', updated_at = now()
     WHERE mm.gym_id = $1 AND mm.status = 'UPCOMING'
       AND mm.starts_on <= (SELECT (now() AT TIME ZONE g.timezone)::date FROM gyms g WHERE g.id = mm.gym_id)
       AND NOT EXISTS (
         SELECT 1 FROM member_memberships other
         WHERE other.member_id = mm.member_id AND other.status = 'ACTIVE' AND other.id != mm.id
       )
     RETURNING mm.id`,
    [gymId]
  );
  for (const row of promoted.rows) await recordEvent(client, gymId, row.id, 'term_started', {});
  return { expired: expired.rows.length, promoted: promoted.rows.length };
}

const DURATION_UNITS = ['day', 'week', 'month', 'year'];
const ACCESS_LEVELS = ['gym_only', 'gym_classes', 'all_access'];
const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

const CURRENCY_RE = /^[A-Z]{3}$/;

function planValidation(data, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const pick = (k) => (partial ? data[k] : data[k]);

  if (!partial || data.name !== undefined) {
    const name = String(pick('name') || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'name is required (max 120 characters)');
    out.name = name;
  }
  if (data.description !== undefined) out.description = data.description || null;
  if (!partial || data.duration_value !== undefined || data.duration_unit !== undefined) {
    const value = data.duration_value ?? 1;
    const unit = data.duration_unit ?? 'month';
    if (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 36) {
      throw new HttpError(400, 'duration_value must be a whole number between 1 and 36');
    }
    if (!DURATION_UNITS.includes(unit)) {
      throw new HttpError(400, `duration_unit must be one of ${DURATION_UNITS.join(', ')}`);
    }
    out.duration_value = Number(value);
    out.duration_unit = unit;
  }
  if (!partial || data.price_cents !== undefined) {
    const price = Number(data.price_cents ?? 0);
    if (!Number.isInteger(price) || price < 0) {
      // negative prices are invalid; zero is a legitimate complimentary plan
      throw new HttpError(400, 'price must be zero or a positive amount (in minor units)');
    }
    if (price > 100_000_000) throw new HttpError(400, 'price exceeds the maximum supported value');
    out.price_cents = price;
  }
  if (data.currency !== undefined || !partial) {
    const currency = data.currency ?? 'INR';
    if (!CURRENCY_RE.test(String(currency))) throw new HttpError(400, 'currency must be a 3-letter code');
    out.currency = currency;
  }
  if (!partial || data.access_level !== undefined) {
    const access = data.access_level ?? 'gym_only';
    if (!ACCESS_LEVELS.includes(access)) {
      throw new HttpError(400, `access_level must be one of ${ACCESS_LEVELS.join(', ')}`);
    }
    out.access_level = access;
  }
  if (!partial || data.included_pt_sessions !== undefined) {
    const pt = Number(data.included_pt_sessions ?? 0);
    if (!Number.isInteger(pt) || pt < 0 || pt > 500) {
      throw new HttpError(400, 'included_pt_sessions must be a whole number between 0 and 500');
    }
    out.included_pt_sessions = pt;
  }
  if (data.status !== undefined) {
    if (!PLAN_STATUSES.includes(data.status)) {
      throw new HttpError(400, `status must be one of ${PLAN_STATUSES.join(', ')}`);
    }
    out.status = data.status;
  }
  return out;
}

// ── plan CRUD ────────────────────────────────────────────────────────────

async function createPlan(gymId, actor, ip, data, gymAudit) {
  const fields = planValidation(data, { partial: false });
  return transaction(async (client) => {
    const { rows: dupes } = await client.query(
      'SELECT id FROM membership_plans WHERE gym_id = $1 AND lower(name) = lower($2)',
      [gymId, fields.name]
    );
    if (dupes.length) throw new HttpError(409, 'A plan with this name already exists at this gym');
    const { rows } = await client.query(
      `INSERT INTO membership_plans
         (gym_id, name, description, duration_value, duration_unit, price_cents,
          currency, access_level, included_pt_sessions, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [gymId, fields.name, fields.description ?? null, fields.duration_value, fields.duration_unit,
       fields.price_cents, fields.currency, fields.access_level, fields.included_pt_sessions,
       fields.status ?? 'DRAFT']
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'plan.created', entity: 'membership_plan', entityId: rows[0].id,
      after: { name: rows[0].name, price_cents: rows[0].price_cents, status: rows[0].status },
    });
    return rows[0];
  });
}

async function updatePlan(gymId, planId, actor, ip, patch, gymAudit) {
  const fields = planValidation(patch, { partial: true });
  return transaction(async (client) => {
    const { rows: beforeRows } = await client.query(
      'SELECT * FROM membership_plans WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [planId, gymId]
    );
    if (!beforeRows.length) throw new HttpError(404, 'Plan not found');
    if (fields.name !== undefined) {
      const { rows: dupes } = await client.query(
        'SELECT id FROM membership_plans WHERE gym_id = $1 AND lower(name) = lower($2) AND id != $3',
        [gymId, fields.name, planId]
      );
      if (dupes.length) throw new HttpError(409, 'A plan with this name already exists at this gym');
    }
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 3}`);
    const { rows } = await client.query(
      `UPDATE membership_plans SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [planId, gymId, ...Object.values(fields)]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'plan.updated', entity: 'membership_plan', entityId: planId,
      before: { price_cents: beforeRows[0].price_cents, status: beforeRows[0].status, name: beforeRows[0].name },
      after: { price_cents: rows[0].price_cents, status: rows[0].status, name: rows[0].name },
    });
    return rows[0];
  });
}

async function listPlans(gymId, { status } = {}) {
  const vals = [gymId];
  const where = ['gym_id = $1'];
  if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
  const { rows } = await query(
    `SELECT * FROM membership_plans WHERE ${where.join(' AND ')}
     ORDER BY (status = 'ACTIVE') DESC, price_cents, created_at DESC`,
    vals
  );
  return rows;
}

async function getPlan(gymId, planId) {
  const { rows } = await query(
    'SELECT * FROM membership_plans WHERE id = $1 AND gym_id = $2', [planId, gymId]
  );
  return rows[0] || null;
}

// ── member memberships ───────────────────────────────────────────────────

async function listMemberMemberships(gymId, memberId) {
  await transaction(async (client) => runMembershipMaintenance(client, gymId));
  const { rows } = await query(
    `SELECT mm.*, gm.first_name, gm.last_name, gm.member_code,
            gm.app_user_id, gm.status AS member_status
     FROM member_memberships mm
     JOIN gym_members gm ON gm.id = mm.member_id
     WHERE mm.gym_id = $1 AND mm.member_id = $2
     ORDER BY mm.starts_on DESC, mm.created_at DESC`,
    [gymId, memberId]
  );
  return rows;
}

// Gym-wide current memberships (the Memberships page).
async function listGymMemberships(gymId, { q, status, limit = 50, offset = 0 } = {}) {
  await transaction(async (client) => runMembershipMaintenance(client, gymId));
  const vals = [gymId];
  const where = ['mm.gym_id = $1'];
  if (status) { vals.push(status); where.push(`mm.status = $${vals.length}`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(gm.first_name ILIKE $${vals.length} OR gm.last_name ILIKE $${vals.length}
                 OR gm.member_code ILIKE $${vals.length} OR mm.plan_name ILIKE $${vals.length})`);
  }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 50, 200)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT mm.*, gm.first_name, gm.last_name, gm.member_code, gm.app_user_id
     FROM member_memberships mm
     JOIN gym_members gm ON gm.id = mm.member_id
     WHERE ${where.join(' AND ')}
     ORDER BY mm.ends_on ASC, mm.created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows;
}

async function getMembership(gymId, memberId, membershipId) {
  const { rows } = await query(
    `SELECT * FROM member_memberships
     WHERE id = $1 AND gym_id = $2 AND member_id = $3`,
    [membershipId, gymId, memberId]
  );
  return rows[0] || null;
}

// Assign a plan to a member. Works with app_user_id NULL or set — the
// module never reads app accounts.
async function assignMembership(gymId, memberId, actor, ip, { plan_id, starts_on, replace_active = false, cancel_reason } = {}, gymAudit) {
  if (!plan_id) throw new HttpError(400, 'plan_id is required');
  const start = starts_on || null;
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) {
    throw new HttpError(400, 'starts_on must be a YYYY-MM-DD date');
  }
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].status === 'CANCELLED') {
      throw new HttpError(400, 'This member has left the gym — reactivate them before assigning a membership');
    }
    const { rows: planRows } = await client.query(
      'SELECT * FROM membership_plans WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [plan_id, gymId]
    );
    if (!planRows.length) throw new HttpError(404, 'Plan not found');
    const plan = planRows[0];
    if (plan.status === 'DRAFT') {
      throw new HttpError(400, 'This plan is still a draft — activate it before assigning');
    }
    if (plan.status === 'ARCHIVED') {
      throw new HttpError(409, 'Archived plans cannot be assigned to members');
    }

    // one running term per member — FROZEN counts (a plan change ends the freeze)
    const { rows: current } = await client.query(
      `SELECT * FROM member_memberships WHERE member_id = $1 AND status IN ('ACTIVE','FROZEN') FOR UPDATE`,
      [memberId]
    );
    if (current.length) {
      if (!replace_active) {
        throw new HttpError(409,
          `This member already has a running membership (${current[0].plan_name}, ${current[0].status}, ends ${current[0].ends_on}). Use a plan change to replace it, or renew.`);
      }
      await client.query(
        `UPDATE member_memberships SET status = 'CANCELLED', cancelled_at = now(),
           cancel_reason = $2, updated_at = now() WHERE id = $1`,
        [current[0].id, cancel_reason || 'plan_change']
      );
      // an open freeze on the replaced term ends with it
      await client.query(
        `UPDATE membership_freezes SET status = 'CANCELLED', ended_on = (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $2))::date,
           updated_at = now() WHERE membership_id = $1 AND status = 'ACTIVE'`,
        [current[0].id, gymId]
      );
      await recordEvent(client, gymId, current[0].id, 'cancelled',
        { details: { reason: cancel_reason || 'plan_change' }, actor });
    }
    const { rows: upcoming } = await client.query(
      `SELECT id FROM member_memberships WHERE member_id = $1 AND status = 'UPCOMING' FOR UPDATE`,
      [memberId]
    );
    if (upcoming.length) {
      throw new HttpError(409, 'This member already has a renewal scheduled — cancel it first');
    }

    // calendar-correct dates in the GYM's timezone, snapshot from the plan
    // at assignment time
    const { rows } = await client.query(
      `INSERT INTO member_memberships
         (gym_id, member_id, plan_id, plan_name, plan_duration_value, plan_duration_unit,
          price_cents, currency, status, starts_on, ends_on)
       SELECT $1, $2, p.id, p.name, p.duration_value, p.duration_unit,
              p.price_cents, p.currency, 'ACTIVE',
              COALESCE($4::date, (now() AT TIME ZONE g.timezone)::date),
              (COALESCE($4::date, (now() AT TIME ZONE g.timezone)::date)
                 + (p.duration_value || ' ' || p.duration_unit)::interval)::date
       FROM membership_plans p JOIN gyms g ON g.id = p.gym_id
       WHERE p.id = $3 AND p.gym_id = $5
       RETURNING *`,
      [gymId, memberId, plan.id, start, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.assigned', entity: 'member_membership', entityId: rows[0].id,
      after: { plan: rows[0].plan_name, price_cents: rows[0].price_cents,
               starts_on: rows[0].starts_on, ends_on: rows[0].ends_on,
               replaced: current[0]?.id ?? null },
    });
    await recordEvent(client, gymId, rows[0].id, current[0] ? 'plan_changed' : 'assigned',
      { details: { plan: rows[0].plan_name, price_cents: rows[0].price_cents }, actor });
    // billing: every sale opens a DUE charge from the term's price snapshot
    await billing.createChargeForMembership(client, gymId, memberId, rows[0], actor);
    return rows[0];
  });
}

async function cancelMembership(gymId, memberId, membershipId, actor, ip, { reason } = {}, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const m = rows[0];
    if (!['ACTIVE', 'FROZEN', 'UPCOMING'].includes(m.status)) {
      throw new HttpError(400, `A ${m.status} membership cannot be cancelled`);
    }
    const updated = await client.query(
      `UPDATE member_memberships SET status = 'CANCELLED', cancelled_at = now(),
         cancel_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, reason || 'member_request']
    );
    if (m.status === 'FROZEN') {
      // cancellation during freeze closes the open freeze with the term
      await client.query(
        `UPDATE membership_freezes SET status = 'CANCELLED', ended_on = (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $2))::date,
           updated_at = now() WHERE membership_id = $1 AND status = 'ACTIVE'`,
        [m.id, gymId]
      );
    }
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.cancelled', entity: 'member_membership', entityId: m.id,
      before: { status: m.status }, after: { status: 'CANCELLED', reason: reason || 'member_request' },
    });
    await recordEvent(client, gymId, m.id, 'cancelled', { details: { reason: reason || 'member_request' }, actor });
    return updated.rows[0];
  });
}

// Renew an ACTIVE term. Early renewals (ends_on in the future) schedule an
// UPCOMING term starting the day after the current one ends; renewing an
// expired-but-uncancelled term starts a new ACTIVE term today. The NEW term
// snapshots the plan's CURRENT price — historical rows are never touched.
async function renewMembership(gymId, memberId, membershipId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    await runMembershipMaintenance(client, gymId);
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const current = rows[0];
    if (current.status === 'FROZEN') {
      throw new HttpError(400, 'Resume the membership before renewing — a freeze pauses the term');
    }
    if (current.status === 'CANCELLED') {
      throw new HttpError(400, 'A cancelled membership cannot be renewed — assign a plan instead');
    }
    if (current.status === 'UPCOMING') {
      throw new HttpError(400, 'This member already has a renewal scheduled');
    }
    const { rows: upcoming } = await client.query(
      `SELECT id FROM member_memberships WHERE member_id = $1 AND status = 'UPCOMING' FOR UPDATE`,
      [memberId]
    );
    if (upcoming.length) throw new HttpError(409, 'This member already has a renewal scheduled');

    const { rows: planRows } = await client.query(
      'SELECT * FROM membership_plans WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [current.plan_id, gymId]
    );
    if (!planRows.length) throw new HttpError(404, 'The plan for this membership no longer exists');
    const plan = planRows[0]; // may be ARCHIVED — existing members keep their plan

    // expiry boundary in the GYM's timezone
    const tzToday = await client.query(
      `SELECT (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date AS d`, [gymId]
    );
    const today = tzToday.rows[0].d; // DATE comes back as a calendar string
    const expired = current.ends_on < today;
    const startsOn = expired ? today : nextDay(current.ends_on);
    const status = expired ? 'ACTIVE' : 'UPCOMING';

    if (expired) {
      await client.query(
        `UPDATE member_memberships SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
        [current.id]
      );
    }

    const created = await client.query(
      `INSERT INTO member_memberships
         (gym_id, member_id, plan_id, plan_name, plan_duration_value, plan_duration_unit,
          price_cents, currency, status, starts_on, ends_on)
       SELECT $1, $2, p.id, p.name, p.duration_value, p.duration_unit,
              p.price_cents, p.currency, $5::text,
              $6::date,
              ($6::date + (p.duration_value || ' ' || p.duration_unit)::interval)::date
       FROM membership_plans p WHERE p.id = $3 AND p.gym_id = $4
       RETURNING *`,
      [gymId, memberId, plan.id, gymId, status, startsOn]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.renewed', entity: 'member_membership', entityId: created.rows[0].id,
      after: { plan: created.rows[0].plan_name, price_cents: created.rows[0].price_cents,
               starts_on: created.rows[0].starts_on, ends_on: created.rows[0].ends_on,
               previous: current.id, previous_price_cents: current.price_cents },
    });
    await recordEvent(client, gymId, created.rows[0].id, 'renewed',
      { details: { previous: current.id, price_cents: created.rows[0].price_cents }, actor });
    await billing.createChargeForMembership(client, gymId, memberId, created.rows[0], actor);
    return created.rows[0];
  });
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── membership lifecycle (Phase 7): freeze / resume / extend ─────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Freeze an ACTIVE term. The term pauses; when the freeze ends the expiry
// moves by the exact number of frozen days (the ONE consistent rule).
async function freezeMembership(gymId, memberId, membershipId, actor, ip, { starts_on, reason } = {}, gymAudit) {
  if (starts_on && !DATE_RE.test(String(starts_on))) {
    throw new HttpError(400, 'starts_on must be a YYYY-MM-DD date');
  }
  return transaction(async (client) => {
    await runMembershipMaintenance(client, gymId);
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const term = rows[0];
    if (term.status === 'FROZEN') throw new HttpError(409, 'This membership is already frozen');
    if (term.status !== 'ACTIVE') {
      throw new HttpError(400, `Only an ACTIVE membership can be frozen (this one is ${term.status})`);
    }
    // freeze boundaries: within the running term, not in the future
    const todayRows = await client.query(
      `SELECT (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date AS d`, [gymId]
    );
    const today = todayRows.rows[0].d;
    const start = starts_on || today;
    if (start > today) throw new HttpError(400, 'A freeze cannot start in the future');
    if (start < term.starts_on) throw new HttpError(400, 'A freeze cannot start before the membership does');
    if (start > term.ends_on) throw new HttpError(400, 'This membership has already ended');

    await client.query(
      `UPDATE member_memberships SET status = 'FROZEN', updated_at = now() WHERE id = $1`,
      [term.id]
    );
    const { rows: freezeRows } = await client.query(
      `INSERT INTO membership_freezes (gym_id, membership_id, starts_on, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [gymId, term.id, start, reason || null, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.frozen', entity: 'member_membership', entityId: term.id,
      after: { freeze: freezeRows[0].id, starts_on: start },
    });
    await recordEvent(client, gymId, term.id, 'frozen',
      { details: { starts_on: start, reason: reason || null }, actor });
    return { membership: { ...term, status: 'FROZEN' }, freeze: freezeRows[0] };
  });
}

// Resume a frozen term (or cancel the freeze — same mechanics, different
// label). The expiry moves forward by the exact number of frozen days
// (the resume date itself is NOT frozen): freeze 01 Aug → resume 01 Sep
// shifts the expiry by 31 days. If the term still ends before today after
// the shift it becomes EXPIRED; a scheduled renewal shifts by the same days.
async function resumeMembership(gymId, memberId, membershipId, actor, ip, { resumed_on, cancel = false } = {}, gymAudit) {
  if (resumed_on && !DATE_RE.test(String(resumed_on))) {
    throw new HttpError(400, 'resumed_on must be a YYYY-MM-DD date');
  }
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const term = rows[0];
    if (term.status !== 'FROZEN') {
      throw new HttpError(400, `This membership is not frozen (it is ${term.status})`);
    }
    const { rows: freezeRows } = await client.query(
      `SELECT * FROM membership_freezes WHERE membership_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [term.id]
    );
    if (!freezeRows.length) {
      // inconsistent state guard — recover by resuming without a shift
      const todayRows = await client.query(
        `SELECT (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date AS d`, [gymId]
      );
      await client.query(
        `UPDATE member_memberships SET status = 'ACTIVE', updated_at = now() WHERE id = $1`,
        [term.id]
      );
      return { membership: { ...term, status: 'ACTIVE' }, frozen_days: 0 };
    }
    const freeze = freezeRows[0];
    const todayRows = await client.query(
      `SELECT (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $1))::date AS d`, [gymId]
    );
    const today = todayRows.rows[0].d;
    const resume = resumed_on || today;
    if (resume > today) throw new HttpError(400, 'The resume date cannot be in the future');
    if (resume < freeze.starts_on) {
      throw new HttpError(400, `The freeze started on ${freeze.starts_on} — resume cannot be earlier`);
    }
    const frozenDays = Math.max(0, Math.round(
      (new Date(`${resume}T00:00:00Z`) - new Date(`${freeze.starts_on}T00:00:00Z`)) / 86400000
    ));

    const updated = await client.query(
      `UPDATE member_memberships SET
         ends_on = ends_on + $2::int,
         status = CASE WHEN ends_on + $2::int < $3::date THEN 'EXPIRED' ELSE 'ACTIVE' END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [term.id, frozenDays, today]
    );
    await client.query(
      `UPDATE membership_freezes SET status = $2, ended_on = $3, updated_at = now() WHERE id = $1`,
      [freeze.id, cancel ? 'CANCELLED' : 'ENDED', resume]
    );
    if (frozenDays > 0) {
      // the scheduled renewal slides with the term
      await client.query(
        `UPDATE member_memberships SET starts_on = starts_on + $2::int, ends_on = ends_on + $2::int,
           updated_at = now() WHERE member_id = $1 AND status = 'UPCOMING'`,
        [term.member_id, frozenDays]
      );
    }
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: cancel ? 'membership.freeze_cancelled' : 'membership.resumed',
      entity: 'member_membership', entityId: term.id,
      before: { status: 'FROZEN', ends_on: term.ends_on },
      after: { status: updated.rows[0].status, ends_on: updated.rows[0].ends_on, frozen_days: frozenDays },
    });
    await recordEvent(client, gymId, term.id, cancel ? 'freeze_cancelled' : 'resumed',
      { details: { frozen_days: frozenDays, ends_on: updated.rows[0].ends_on }, actor });
    return { membership: updated.rows[0], frozen_days: frozenDays };
  });
}

// Manual extension: push the expiry out by N days. A scheduled renewal
// slides by the same days so it still starts the day after the term ends.
async function extendMembership(gymId, memberId, membershipId, actor, ip, { days } = {}, gymAudit) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new HttpError(400, 'days must be a whole number between 1 and 365');
  }
  return transaction(async (client) => {
    await runMembershipMaintenance(client, gymId);
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const term = rows[0];
    if (term.status !== 'ACTIVE') {
      throw new HttpError(400, `Only an ACTIVE membership can be extended (this one is ${term.status})`);
    }
    const updated = await client.query(
      `UPDATE member_memberships SET ends_on = ends_on + $2::int, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [term.id, n]
    );
    await client.query(
      `UPDATE member_memberships SET starts_on = starts_on + $2::int, ends_on = ends_on + $2::int,
         updated_at = now() WHERE member_id = $1 AND status = 'UPCOMING'`,
      [term.member_id, n]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.extended', entity: 'member_membership', entityId: term.id,
      before: { ends_on: term.ends_on }, after: { ends_on: updated.rows[0].ends_on, days: n },
    });
    await recordEvent(client, gymId, term.id, 'extended',
      { details: { days: n, ends_on: updated.rows[0].ends_on }, actor });
    return updated.rows[0];
  });
}

// The member's lifecycle timeline (spec: Jan active → Aug frozen → …).
async function listMembershipEvents(gymId, memberId) {
  await transaction(async (client) => runMembershipMaintenance(client, gymId));
  const { rows } = await query(
    `SELECT e.*, u.name AS actor_name, mm.plan_name, mm.starts_on AS term_start
     FROM membership_events e
     JOIN member_memberships mm ON mm.id = e.membership_id
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.gym_id = $1 AND mm.member_id = $2
     ORDER BY e.created_at DESC`,
    [gymId, memberId]
  );
  return rows;
}

module.exports = {
  DURATION_UNITS, ACCESS_LEVELS, PLAN_STATUSES,
  createPlan, updatePlan, listPlans, getPlan,
  listMemberMemberships, listGymMemberships, getMembership,
  assignMembership, cancelMembership, renewMembership,
  freezeMembership, resumeMembership, extendMembership, listMembershipEvents,
  runMembershipMaintenance,
};
