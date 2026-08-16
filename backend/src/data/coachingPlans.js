// Generic data access for diet and supplement plans — both share the exact
// same shape, so one parameterized module serves both (table names are
// internal constants, never caller-supplied).
const { query, transaction } = require('../db/pool');
const { assertActiveAssociation } = require('./assignedPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONFIG = {
  diet: {
    plansTable: 'diet_plans',
    itemsTable: 'diet_plan_items',
    planFk: 'diet_plan_id',
    checkinsTable: 'diet_checkins',
    doneCol: 'followed',
    itemCols: ['meal_label', 'description'],
    validateItem(item) {
      if (!item.meal_label || !item.description) {
        throw new HttpError(400, 'Each meal requires meal_label and description');
      }
      return [item.meal_label, item.description];
    },
  },
  supplement: {
    plansTable: 'supplement_plans',
    itemsTable: 'supplement_plan_items',
    planFk: 'supplement_plan_id',
    checkinsTable: 'supplement_checkins',
    doneCol: 'taken',
    itemCols: ['supplement_name', 'dosage', 'timing', 'notes'],
    validateItem(item) {
      if (!item.supplement_name) {
        throw new HttpError(400, 'Each supplement requires supplement_name');
      }
      return [item.supplement_name, item.dosage || null, item.timing || null, item.notes || null];
    },
  },
};

function cfg(kind) {
  const c = CONFIG[kind];
  if (!c) throw new HttpError(400, 'Unknown plan kind');
  return c;
}

async function createPlan(kind, { trainerId, clientId, name, notes, items, createdBy = 'trainer' }) {
  const c = cfg(kind);
  // Only trainer-authored plans require an active association — a client's
  // own plan needs no trainer relationship (same spirit as self-made routines).
  if (createdBy === 'trainer') {
    await assertActiveAssociation(trainerId, clientId);
  }
  if (!name || !Array.isArray(items) || !items.length) {
    throw new HttpError(400, 'name and a non-empty items array are required');
  }
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ${c.plansTable} (trainer_id, client_id, name, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [createdBy === 'trainer' ? trainerId : null, clientId, name, notes || null, createdBy]
    );
    const plan = rows[0];
    for (let i = 0; i < items.length; i++) {
      const vals = c.validateItem(items[i]);
      const cols = [...c.itemCols, 'order_index'];
      const placeholders = cols.map((_, j) => `$${j + 1}`).join(', ');
      await client.query(
        `INSERT INTO ${c.itemsTable} (${cols.join(', ')}, ${c.planFk})
         SELECT ${placeholders}, $${cols.length + 1}`,
        [...vals, i, plan.id]
      );
    }
    return plan;
  });
}

async function listActiveForClient(kind, trainerId, clientId) {
  const c = cfg(kind);
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `SELECT p.*, (
       SELECT COUNT(*) FROM ${c.itemsTable} i WHERE i.${c.planFk} = p.id
     ) AS item_count
     FROM ${c.plansTable} p
     WHERE p.trainer_id = $1 AND p.client_id = $2 AND p.status = 'active'
     ORDER BY p.created_at DESC`,
    [trainerId, clientId]
  );
  return rows;
}

async function listActiveForOwner(kind, clientId) {
  const c = cfg(kind);
  const { rows } = await query(
    `SELECT p.*, u.name AS trainer_name FROM ${c.plansTable} p
      LEFT JOIN users u ON u.id = p.trainer_id
      WHERE p.client_id = $1 AND p.status = 'active'
      ORDER BY p.created_at DESC`,
    [clientId]
  );
  for (const plan of rows) {
    const items = await query(
      `SELECT * FROM ${c.itemsTable} WHERE ${c.planFk} = $1 ORDER BY order_index`,
      [plan.id]
    );
    plan.items = items.rows;
  }
  return rows;
}

async function getPlanWithItems(kind, planId) {
  const c = cfg(kind);
  const { rows } = await query(`SELECT * FROM ${c.plansTable} WHERE id = $1`, [planId]);
  if (!rows.length) return null;
  const items = await query(
    `SELECT * FROM ${c.itemsTable} WHERE ${c.planFk} = $1 ORDER BY order_index`,
    [planId]
  );
  rows[0].items = items.rows;
  return rows[0];
}

async function archivePlan(kind, trainerId, clientId, planId) {
  const c = cfg(kind);
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `UPDATE ${c.plansTable} SET status = 'archived'
     WHERE id = $1 AND trainer_id = $2 AND client_id = $3
     RETURNING *`,
    [planId, trainerId, clientId]
  );
  if (!rows.length) throw new HttpError(404, 'Plan not found for this client');
  return rows[0];
}

// Client check-in upsert: one row per plan per day. Ownership checked
// against the plan's client_id.
async function checkIn(kind, clientId, planId, date, done, note) {
  const c = cfg(kind);
  const plan = await query(`SELECT client_id FROM ${c.plansTable} WHERE id = $1`, [planId]);
  if (!plan.rows.length || plan.rows[0].client_id !== clientId) {
    throw new HttpError(404, 'Plan not found');
  }
  const { rows } = await query(
    `INSERT INTO ${c.checkinsTable} (${c.planFk}, client_id, date, ${c.doneCol}, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (${c.planFk}, date) DO UPDATE SET
       ${c.doneCol} = EXCLUDED.${c.doneCol}, note = EXCLUDED.note
     RETURNING *`,
    [planId, clientId, date, !!done, note || null]
  );
  return rows[0];
}

async function listCheckins(kind, trainerId, clientId, planId, from, to) {
  const c = cfg(kind);
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `SELECT * FROM ${c.checkinsTable}
     WHERE ${c.planFk} = $1
       AND ($2::date IS NULL OR date >= $2)
       AND ($3::date IS NULL OR date <= $3)
     ORDER BY date DESC`,
    [planId, from || null, to || null]
  );
  return rows;
}

// Recent check-ins for the plan OWNER (client) — drives the client-side strip
async function listMyCheckins(kind, clientId, planId) {
  const c = cfg(kind);
  const { rows } = await query(
    `SELECT * FROM ${c.checkinsTable} WHERE ${c.planFk} = $1 AND client_id = $2 ORDER BY date DESC LIMIT 30`,
    [planId, clientId]
  );
  return rows;
}

module.exports = {
  createPlan,
  listActiveForClient,
  listActiveForOwner,
  getPlanWithItems,
  archivePlan,
  checkIn,
  listCheckins,
  listMyCheckins,
};
