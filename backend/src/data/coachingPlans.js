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

async function createPlan(kind, payload) {
  const { trainerId, clientId, name, notes, items, days, createdBy = 'trainer' } = payload;
  const c = cfg(kind);
  // Only trainer-authored plans require an active association — a client's
  // own plan needs no trainer relationship (same spirit as self-made routines).
  if (createdBy === 'trainer') {
    await assertActiveAssociation(trainerId, clientId);
  }
  if (!name) throw new HttpError(400, 'name is required');

  // Diet: nested days / meals / items with catalog snapshotting
  if (kind === 'diet') {
    if (!Array.isArray(days) || !days.length) {
      throw new HttpError(400, 'a non-empty days array is required');
    }
    return createDietTree({ ...payload, createdBy });
  }
  if (!Array.isArray(items) || !items.length) {
    throw new HttpError(400, 'a non-empty items array are required');
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

// Diet plan tree creation (one transaction). Catalog-sourced items are
// SNAPSHOTTED server-side from the catalog at insert time, so later catalog
// edits never alter already-assigned plans.
async function createDietTree({ trainerId, clientId, name, notes, days, createdBy = 'trainer', targets = {} }) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO diet_plans
         (trainer_id, client_id, name, notes, created_by,
          daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        createdBy === 'trainer' ? trainerId : null,
        clientId, name, notes || null, createdBy,
        targets.daily_calorie_target ?? null,
        targets.daily_protein_target ?? null,
        targets.daily_carbs_target ?? null,
        targets.daily_fat_target ?? null,
      ]
    );
    const plan = rows[0];

    // batch-load catalog references once (scoped to this trainer)
    const catalogIds = [];
    for (const d of days) {
      for (const m of d.meals || []) {
        for (const it of m.items || []) {
          if (it.catalog_item_id) catalogIds.push(it.catalog_item_id);
        }
      }
    }
    const catalogMap = new Map();
    if (catalogIds.length) {
      // owner-scoped lookup: trainer dishes (trainer-built plans) or the
      // client's own My Dishes (self-authored plans)
      const { rows: catalogRows } = await client.query(
        `SELECT * FROM meal_catalog_items
         WHERE id = ANY($1::uuid[])
           AND ((trainer_id = $2 AND $2 IS NOT NULL) OR (user_id = $3 AND $3 IS NOT NULL))`,
        [catalogIds, createdBy === 'trainer' ? trainerId : null, createdBy === 'client' ? clientId : null]
      );
      for (const cr of catalogRows) catalogMap.set(cr.id, cr);
    }

    for (let di = 0; di < days.length; di++) {
      const d = days[di];
      const { rows: dayRows } = await client.query(
        `INSERT INTO diet_plan_days (diet_plan_id, day_label, order_index)
         VALUES ($1,$2,$3) RETURNING id`,
        [plan.id, d.day_label || `Day ${di + 1}`, di]
      );
      const dayId = dayRows[0].id;
      for (let mi = 0; mi < (d.meals || []).length; mi++) {
        const m = d.meals[mi];
        if (!m.meal_type) throw new HttpError(400, 'each meal slot requires meal_type');
        const { rows: mealRows } = await client.query(
          `INSERT INTO diet_plan_meals (diet_plan_day_id, meal_type, order_index, slot_note)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [dayId, m.meal_type, mi, m.slot_note || null]
        );
        const mealId = mealRows[0].id;
        for (let ii = 0; ii < (m.items || []).length; ii++) {
          const it = m.items[ii] || {};
          const cat = it.catalog_item_id ? catalogMap.get(it.catalog_item_id) : null;
          if (it.catalog_item_id && !cat) {
            throw new HttpError(400, 'Catalog item not found for this owner');
          }
          const snap = cat || it; // custom items carry their own fields
          await client.query(
            `INSERT INTO diet_plan_meal_items
               (diet_plan_meal_id, catalog_item_id, name, calories, protein_g, carbs_g, fat_g,
                serving_size, recipe_url, quantity_multiplier, client_note, order_index)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              mealId,
              cat ? cat.id : null,
              String(snap.name || '').trim(),
              snap.calories != null ? Math.round(Number(snap.calories)) : null,
              snap.protein_g != null ? Number(snap.protein_g) : null,
              snap.carbs_g != null ? Number(snap.carbs_g) : null,
              snap.fat_g != null ? Number(snap.fat_g) : null,
              snap.serving_size || null,
              snap.recipe_url || null,
              it.quantity_multiplier != null ? Number(it.quantity_multiplier) : 1,
              it.client_note || null,
              ii,
            ]
          );
        }
      }
    }
    return plan;
  });
}

// Client-side: update one of my OWN diet plans (client-authored only -
// trainer-assigned plans are not editable by the client). Full tree replace.
async function updateOwnDietPlan(clientId, planId, payload) {
  const { rows } = await query(
    'SELECT id, client_id, created_by FROM diet_plans WHERE id = $1',
    [planId]
  );
  if (!rows.length || rows[0].client_id !== clientId) {
    throw new HttpError(404, 'Plan not found');
  }
  if (rows[0].created_by !== 'client') {
    throw new HttpError(403, 'Only your own plans can be edited');
  }
  await transaction(async (client) => {
    await client.query(
      `UPDATE diet_plans SET
         name = $2, notes = $3,
         daily_calorie_target = $4, daily_protein_target = $5,
         daily_carbs_target = $6, daily_fat_target = $7
       WHERE id = $1`,
      [
        planId,
        payload.name,
        payload.notes || null,
        (payload.targets || {}).daily_calorie_target ?? null,
        (payload.targets || {}).daily_protein_target ?? null,
        (payload.targets || {}).daily_carbs_target ?? null,
        (payload.targets || {}).daily_fat_target ?? null,
      ]
    );
    await client.query('DELETE FROM diet_plan_days WHERE diet_plan_id = $1', [planId]);
    const days = payload.days || [];
    for (let di = 0; di < days.length; di++) {
      const d = days[di];
      const { rows: dayRows } = await client.query(
        `INSERT INTO diet_plan_days (diet_plan_id, day_label, order_index)
         VALUES ($1,$2,$3) RETURNING id`,
        [planId, d.day_label || `Day ${di + 1}`, di]
      );
      for (let mi = 0; mi < (d.meals || []).length; mi++) {
        const m = d.meals[mi];
        const { rows: mealRows } = await client.query(
          `INSERT INTO diet_plan_meals (diet_plan_day_id, meal_type, order_index, slot_note)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [dayRows[0].id, m.meal_type, mi, m.slot_note || null]
        );
        for (let ii = 0; ii < (m.items || []).length; ii++) {
          const it = m.items[ii] || {};
          await client.query(
            `INSERT INTO diet_plan_meal_items
               (diet_plan_meal_id, name, calories, protein_g, carbs_g, fat_g,
                serving_size, recipe_url, quantity_multiplier, client_note, order_index)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              mealRows[0].id,
              String(it.name || '').trim(),
              it.calories != null ? Math.round(Number(it.calories)) : null,
              it.protein_g != null ? Number(it.protein_g) : null,
              it.carbs_g != null ? Number(it.carbs_g) : null,
              it.fat_g != null ? Number(it.fat_g) : null,
              it.serving_size || null,
              it.recipe_url || null,
              it.quantity_multiplier != null ? Number(it.quantity_multiplier) : 1,
              it.client_note || null,
              ii,
            ]
          );
        }
      }
    }
  });
  return getPlanWithItems('diet', planId);
}

// Client-side: delete one of my OWN client-authored plan
async function deleteOwnPlan(kind, clientId, planId) {
  const c = cfg(kind);
  const { rows } = await query(
    `SELECT id, client_id, created_by FROM ${c.plansTable} WHERE id = $1`,
    [planId]
  );
  if (!rows.length || rows[0].client_id !== clientId) {
    throw new HttpError(404, 'Plan not found');
  }
  if (rows[0].created_by !== 'client') {
    throw new HttpError(403, 'Only your own plans can be deleted');
  }
  await query(`DELETE FROM ${c.plansTable} WHERE id = $1`, [planId]);
}

async function listActiveForClient(kind, trainerId, clientId) {
  const c = cfg(kind);
  await assertReadableAssociation(trainerId, clientId);
  // diet lists count MEAL SLOTS (what the trainer builds), not dish items
  const countExpr = kind === 'diet'
    ? `(SELECT COUNT(*) FROM diet_plan_meals m
        JOIN diet_plan_days d ON d.id = m.diet_plan_day_id
        WHERE d.diet_plan_id = p.id)`
    : `(SELECT COUNT(*) FROM ${c.itemsTable} i WHERE i.${c.planFk} = p.id)`;
  const { rows } = await query(
    `SELECT p.*, ${countExpr} AS item_count
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
        AND (p.created_by = 'client' OR EXISTS (
          SELECT 1 FROM trainer_clients tc
          WHERE tc.trainer_id = p.trainer_id AND tc.client_id = p.client_id
            AND tc.status = 'active'
        ))
      ORDER BY p.created_at DESC`,
    [clientId]
  );
  for (const plan of rows) {
    if (kind === 'diet') {
      const nested = await getPlanWithItems('diet', plan.id);
      plan.days = nested ? nested.days : [];
    } else {
      const items = await query(
        `SELECT * FROM ${c.itemsTable} WHERE ${c.planFk} = $1 ORDER BY order_index`,
        [plan.id]
      );
      plan.items = items.rows;
    }
  }
  return rows;
}

async function getPlanWithItems(kind, planId) {
  const c = cfg(kind);
  const { rows } = await query(`SELECT * FROM ${c.plansTable} WHERE id = $1`, [planId]);
  if (!rows.length) return null;
  if (kind === 'diet') {
    // nested days -> meals -> snapshot items (the flat table is deprecated)
    const days = await query(
      'SELECT * FROM diet_plan_days WHERE diet_plan_id = $1 ORDER BY order_index',
      [planId]
    );
    for (const d of days.rows) {
      const meals = await query(
        'SELECT * FROM diet_plan_meals WHERE diet_plan_day_id = $1 ORDER BY order_index',
        [d.id]
      );
      for (const m of meals.rows) {
        const items = await query(
          'SELECT * FROM diet_plan_meal_items WHERE diet_plan_meal_id = $1 ORDER BY order_index',
          [m.id]
        );
        m.items = items.rows;
      }
      d.meals = meals.rows;
    }
    rows[0].days = days.rows;
    return rows[0];
  }
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
  await assertReadableAssociation(trainerId, clientId);
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

// Read access during the 30-day archive window: 'active' OR 'archived'.
// Writes (create/archive/etc.) keep using assertActiveAssociation.
async function assertReadableAssociation(trainerId, clientId) {
  const { rows } = await query(
    `SELECT 1 FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status IN ('active', 'archived')`,
    [trainerId, clientId]
  );
  if (!rows.length) throw new HttpError(403, 'No active association with this client');
}

module.exports = {
  assertReadableAssociation,
  createPlan,
  updateOwnDietPlan,
  deleteOwnPlan,
  listActiveForClient,
  listActiveForOwner,
  getPlanWithItems,
  archivePlan,
  checkIn,
  listCheckins,
  listMyCheckins,
};
