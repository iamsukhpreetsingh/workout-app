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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

    // one ACTIVE / UPCOMING term per member
    const { rows: current } = await client.query(
      `SELECT * FROM member_memberships WHERE member_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [memberId]
    );
    if (current.length) {
      if (!replace_active) {
        throw new HttpError(409,
          `This member already has an ACTIVE membership (${current[0].plan_name}, ends ${current[0].ends_on}). Use a plan change to replace it, or renew.`);
      }
      await client.query(
        `UPDATE member_memberships SET status = 'CANCELLED', cancelled_at = now(),
           cancel_reason = $2, updated_at = now() WHERE id = $1`,
        [current[0].id, cancel_reason || 'plan_change']
      );
    }
    const { rows: upcoming } = await client.query(
      `SELECT id FROM member_memberships WHERE member_id = $1 AND status = 'UPCOMING' FOR UPDATE`,
      [memberId]
    );
    if (upcoming.length) {
      throw new HttpError(409, 'This member already has a renewal scheduled — cancel it first');
    }

    // calendar-correct end date, snapshot from the plan at assignment time
    const { rows } = await client.query(
      `INSERT INTO member_memberships
         (gym_id, member_id, plan_id, plan_name, plan_duration_value, plan_duration_unit,
          price_cents, currency, status, starts_on, ends_on)
       SELECT $1, $2, p.id, p.name, p.duration_value, p.duration_unit,
              p.price_cents, p.currency, 'ACTIVE',
              COALESCE($4::date, CURRENT_DATE),
              (COALESCE($4::date, CURRENT_DATE) + (p.duration_value || ' ' || p.duration_unit)::interval)::date
       FROM membership_plans p WHERE p.id = $3 AND p.gym_id = $5
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
    if (m.status !== 'ACTIVE' && m.status !== 'UPCOMING') {
      throw new HttpError(400, `A ${m.status} membership cannot be cancelled`);
    }
    const updated = await client.query(
      `UPDATE member_memberships SET status = 'CANCELLED', cancelled_at = now(),
         cancel_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, reason || 'member_request']
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'membership.cancelled', entity: 'member_membership', entityId: m.id,
      before: { status: m.status }, after: { status: 'CANCELLED', reason: reason || 'member_request' },
    });
    return updated.rows[0];
  });
}

// Renew an ACTIVE term. Early renewals (ends_on in the future) schedule an
// UPCOMING term starting the day after the current one ends; renewing an
// expired-but-uncancelled term starts a new ACTIVE term today. The NEW term
// snapshots the plan's CURRENT price — historical rows are never touched.
async function renewMembership(gymId, memberId, membershipId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM member_memberships WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [membershipId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Membership not found');
    const current = rows[0];
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

    const today = new Date().toISOString().slice(0, 10);
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
    return created.rows[0];
  });
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  DURATION_UNITS, ACCESS_LEVELS, PLAN_STATUSES,
  createPlan, updatePlan, listPlans, getPlan,
  listMemberMemberships, listGymMemberships, getMembership,
  assignMembership, cancelMembership, renewMembership,
};
