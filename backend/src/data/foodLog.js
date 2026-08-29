// foodLog.js — data access for the synced food diary (backup_food_log_entries,
// migration 038). Same conventions as every backup entity:
//  - upserts keyed (user_id, local_entity_id), last-write-wins → idempotent
//    under repeated syncs;
//  - deletes are IDEMPOTENT (never 404-loop);
//  - trainer reads filter on plan_server_id — self-authored diary entries
//    (plan_server_id IS NULL) are never visible to anyone but the owner.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SOURCES = ['planned', 'swapped', 'extra', 'free_logged'];

async function upsertFoodLogEntries(userId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of list) {
    if (!e || !e.local_entity_id || !e.name || !e.log_date) {
      throw new HttpError(400, 'Each entry requires local_entity_id, name and log_date');
    }
    const source = SOURCES.includes(e.source) ? e.source : 'free_logged';
    const { rows: r } = await query(
      `INSERT INTO backup_food_log_entries
         (user_id, local_entity_id, plan_ref, plan_server_id, plan_version_id, log_date,
          meal_type, source, planned_item_ref, name, calories, protein_g, carbs_g, fat_g,
          serving_size, quantity, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         plan_ref = EXCLUDED.plan_ref, plan_server_id = EXCLUDED.plan_server_id,
         plan_version_id = EXCLUDED.plan_version_id, log_date = EXCLUDED.log_date,
         meal_type = EXCLUDED.meal_type, source = EXCLUDED.source,
         planned_item_ref = EXCLUDED.planned_item_ref, name = EXCLUDED.name,
         calories = EXCLUDED.calories, protein_g = EXCLUDED.protein_g,
         carbs_g = EXCLUDED.carbs_g, fat_g = EXCLUDED.fat_g,
         serving_size = EXCLUDED.serving_size, quantity = EXCLUDED.quantity,
         logged_at = EXCLUDED.logged_at, updated_at = now()
       RETURNING *`,
      [userId, String(e.local_entity_id), e.plan_ref ?? null, e.plan_server_id ?? null,
       e.plan_version_id ?? null, String(e.log_date).slice(0, 10), e.meal_type ?? null,
       source, e.planned_item_ref != null ? String(e.planned_item_ref) : null,
       String(e.name), e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null,
       e.fat_g ?? null, e.serving_size ?? null, e.quantity ?? 1, e.logged_at ?? new Date().toISOString()]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listFoodLogEntries(userId, since) {
  const { rows } = await query(
    `SELECT * FROM backup_food_log_entries WHERE user_id = $1
     ${since ? 'AND updated_at > $2' : ''}
     ORDER BY log_date ASC, logged_at ASC`,
    since ? [userId, since] : [userId]
  );
  return rows;
}

async function deleteFoodLogEntry(userId, localId) {
  await query(
    'DELETE FROM backup_food_log_entries WHERE user_id = $1 AND local_entity_id = $2',
    [userId, String(localId)]
  );
  return { ok: true };
}

// Deleting a self-authored plan cascades to its diary rows (the mobile
// deleteDietPlan removes them locally; this keeps the server in step).
async function deleteFoodLogForPlanRef(userId, planRef) {
  await query(
    'DELETE FROM backup_food_log_entries WHERE user_id = $1 AND plan_ref = $2',
    [userId, String(planRef)]
  );
  return { ok: true };
}

// TRAINER READ — plan_server_id filter enforces the permission rule (only
// trainer-assigned plans are visible), and the readable-association guard
// lives in the route. Returns raw diary rows for a date range.
async function listClientFoodLogs(trainerId, clientId, planServerId, from, to) {
  const { rows } = await query(
    `SELECT f.* FROM backup_food_log_entries f
     JOIN diet_plans p ON p.id = f.plan_server_id
     WHERE p.trainer_id = $1 AND p.client_id = $2
       AND ($3::uuid IS NULL OR f.plan_server_id = $3::uuid)
       AND ($4::date IS NULL OR f.log_date >= $4::date)
       AND ($5::date IS NULL OR f.log_date <= $5::date)
     ORDER BY f.log_date ASC, f.logged_at ASC`,
    [trainerId, clientId, planServerId || null, from || null, to || null]
  );
  return rows;
}

// raw diary rows for the monitoring service (already association-checked);
// self-authored rows (plan_server_id IS NULL) are excluded by the join.
async function listClientFoodLogsForMonitoring(trainerId, clientId, fromDate, toDate) {
  return listClientFoodLogs(trainerId, clientId, null, fromDate, toDate);
}

module.exports = {
  upsertFoodLogEntries,
  listFoodLogEntries,
  deleteFoodLogEntry,
  deleteFoodLogForPlanRef,
  listClientFoodLogs,
  listClientFoodLogsForMonitoring,
  HttpError,
};
