// Data access for assigned plans. Creation requires an ACTIVE association.
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function assertActiveAssociation(trainerId, clientId) {
  const { rows } = await query(
    `SELECT 1 FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'`,
    [trainerId, clientId]
  );
  if (!rows.length) {
    throw new HttpError(403, 'No active trainer-client association for this pair');
  }
}

// exercises: [{ exercise_name, target_sets, target_reps, target_weight_note,
//               order_index, rest_seconds, notes }]
async function createAssignedPlan({ trainerId, clientId, name, notes, exercises }) {
  await assertActiveAssociation(trainerId, clientId);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO assigned_plans (trainer_id, client_id, name, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [trainerId, clientId, name, notes || null]
    );
    const plan = rows[0];
    for (const ex of exercises || []) {
      await client.query(
        `INSERT INTO assigned_plan_exercises
         (assigned_plan_id, exercise_name, target_sets, target_reps, target_weight_note, order_index, rest_seconds, notes, group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          plan.id,
          ex.exercise_name,
          ex.target_sets,
          ex.target_reps || null,
          ex.target_weight_note || null,
          ex.order_index,
          ex.rest_seconds || null,
          ex.notes || null,
          ex.group_id || null,
        ]
      );
    }
    return plan;
  });
}

async function listAssignedPlans({ trainerId, clientId, forClientId }) {
  // forClientId: client viewing their own assigned plans (any trainer)
  const { rows } = await query(
    `SELECT p.* FROM assigned_plans p
     WHERE ($1::uuid IS NULL OR p.trainer_id = $1)
       AND ($2::uuid IS NULL OR p.client_id = $2)
       AND ($3::uuid IS NULL OR p.client_id = $3)
     ORDER BY p.created_at DESC`,
    [trainerId || null, clientId || null, forClientId || null]
  );
  return rows;
}

async function getAssignedPlan(id) {
  const { rows } = await query('SELECT * FROM assigned_plans WHERE id = $1', [id]);
  if (!rows.length) return null;
  const plan = rows[0];
  const ex = await query(
    'SELECT * FROM assigned_plan_exercises WHERE assigned_plan_id = $1 ORDER BY order_index',
    [id]
  );
  plan.exercises = ex.rows;
  return plan;
}

async function archiveAssignedPlan(id) {
  const { rows } = await query(
    "UPDATE assigned_plans SET status = 'archived' WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

// Archive only when the plan belongs to this trainer+client pair
async function archiveAssignedPlanForPair(trainerId, clientId, planId) {
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `UPDATE assigned_plans SET status = 'archived'
     WHERE id = $1 AND trainer_id = $2 AND client_id = $3
     RETURNING *`,
    [planId, trainerId, clientId]
  );
  if (!rows.length) throw new HttpError(404, 'Plan not found for this client');
  return rows[0];
}

// Active plans for a client with exercise counts (single query)
async function listActiveForClient(trainerId, clientId) {
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `SELECT p.*, (
       SELECT COUNT(*) FROM assigned_plan_exercises e WHERE e.assigned_plan_id = p.id
     ) AS exercise_count
     FROM assigned_plans p
     WHERE p.trainer_id = $1 AND p.client_id = $2 AND p.status = 'active'
     ORDER BY p.created_at DESC`,
    [trainerId, clientId]
  );
  return rows;
}

async function deleteAssignedPlan(id) {
  await query('DELETE FROM assigned_plans WHERE id = $1', [id]);
}

async function updateAssignedPlan(planId, trainerId, clientId, name, notes, exercises) {
  await assertActiveAssociation(trainerId, clientId);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE assigned_plans SET name = $1, notes = $2 WHERE id = $3 AND trainer_id = $4 AND client_id = $5 RETURNING *`,
      [name, notes || null, planId, trainerId, clientId]
    );
    if (!rows.length) {
      throw new HttpError(404, 'Plan not found for this client');
    }
    const plan = rows[0];
    await client.query('DELETE FROM assigned_plan_exercises WHERE assigned_plan_id = $1', [planId]);
    for (const ex of exercises || []) {
      await client.query(
        `INSERT INTO assigned_plan_exercises
         (assigned_plan_id, exercise_name, target_sets, target_reps, target_weight_note, order_index, rest_seconds, notes, group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          planId,
          ex.exercise_name,
          ex.target_sets,
          ex.target_reps || null,
          ex.target_weight_note || null,
          ex.order_index,
          ex.rest_seconds || null,
          ex.notes || null,
          ex.group_id || null,
        ]
      );
    }
    return plan;
  });
}

// Client-facing: my active assigned plans, newest first, with exercises
// and the assigning trainer's name.
async function listActiveForClientId(clientId) {
  const { rows: plans } = await query(
    `SELECT p.*, u.name AS trainer_name FROM assigned_plans p
     JOIN users u ON u.id = p.trainer_id
     WHERE p.client_id = $1 AND p.status = 'active'
     ORDER BY p.created_at DESC`,
    [clientId]
  );
  for (const plan of plans) {
    const ex = await query(
      'SELECT * FROM assigned_plan_exercises WHERE assigned_plan_id = $1 ORDER BY order_index',
      [plan.id]
    );
    plan.exercises = ex.rows;
  }
  return plans;
}

module.exports = {
  assertActiveAssociation,
  createAssignedPlan,
  listActiveForClientId,
  listActiveForClient,
  archiveAssignedPlanForPair,
  listAssignedPlans,
  getAssignedPlan,
  archiveAssignedPlan,
  deleteAssignedPlan,
  updateAssignedPlan,
};
