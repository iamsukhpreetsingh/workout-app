// Data access for client_workout_plans — user-created workout plans synced to cloud.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Batch upsert workout plans
async function upsertTemplates(clientId, templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new HttpError(400, 'Body must be a non-empty array of templates');
  }
  const rows = [];
  for (const t of templates) {
    if (!t || !t.local_plan_id) {
      throw new HttpError(400, 'Each template requires local_plan_id');
    }
    const { rows: r } = await query(
      `INSERT INTO client_workout_plans
         (client_id, local_plan_id, name, notes, exercises, tags, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (client_id, local_plan_id) DO UPDATE SET
         name = EXCLUDED.name,
         notes = EXCLUDED.notes,
         exercises = EXCLUDED.exercises,
         tags = EXCLUDED.tags,
         updated_at = EXCLUDED.updated_at,
         synced_at = now()
       RETURNING *`,
      [
        clientId,
        String(t.local_plan_id),
        t.name || 'Untitled',
        t.notes || null,
        JSON.stringify(t.exercises || []),
        JSON.stringify(t.tags || []),
        t.created_at || new Date().toISOString(),
        t.updated_at || new Date().toISOString(),
      ]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listForClient(clientId) {
  const { rows } = await query(
    `SELECT id, local_plan_id, name, notes, exercises, tags, created_at, updated_at
     FROM client_workout_plans
     WHERE client_id = $1
     ORDER BY updated_at DESC`,
    [clientId]
  );
  return rows;
}

async function deleteForClient(clientId, localPlanId) {
  const { rowCount } = await query(
    `DELETE FROM client_workout_plans WHERE client_id = $1 AND local_plan_id = $2`,
    [clientId, localPlanId]
  );
  if (rowCount === 0) {
    throw new HttpError(404, 'Plan not found');
  }
  return { ok: true };
}

module.exports = { upsertTemplates, listForClient, deleteForClient };
