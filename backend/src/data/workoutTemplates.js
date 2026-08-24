// Data access for the trainer-owned workout template library. Assignments
// are SNAPSHOT copies — templates and assigned_plans never stay in sync.
const { query, transaction } = require('../db/pool');
const { assertActiveAssociation } = require('./assignedPlans');
const { normalizeAlternatives, insertForParent, fetchByParents } = require('./alternatives');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeExercises(exercises) {
  if (!Array.isArray(exercises) || !exercises.length) {
    throw new HttpError(400, 'a non-empty exercises array is required');
  }
  return exercises.map((ex, i) => ({
    exercise_name: String(ex.exercise_name || '').trim(),
    target_sets: Math.max(1, Math.round(Number(ex.target_sets) || 3)),
    target_reps: ex.target_reps || null,
    target_weight_note: ex.target_weight_note || null,
    order_index: ex.order_index ?? i,
    rest_seconds: ex.rest_seconds != null ? Math.round(Number(ex.rest_seconds)) : null,
    notes: ex.notes || null,
    group_id: ex.group_id || null,
  })).filter((ex) => ex.exercise_name);
}

// Server-side validation happens here: a 4th alternative or a duplicate
// name is REJECTED (400), not truncated.
function normalizeExercisesWithAlternatives(exercises) {
  return normalizeExercises(exercises).map((ex, i) => ({
    ...ex,
    alternatives: normalizeAlternatives(ex.exercise_name, exercises[i]?.alternatives),
  }));
}

async function createTemplate(trainerId, { name, notes, tags, exercises }) {
  if (!name || !String(name).trim()) throw new HttpError(400, 'name is required');
  const items = normalizeExercisesWithAlternatives(exercises);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO workout_templates (trainer_id, name, notes, tags)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [trainerId, String(name).trim(), notes || null, Array.isArray(tags) ? tags.map(String) : []]
    );
    const tpl = rows[0];
    await insertExercises(client, tpl.id, items);
    return tpl;
  });
}

async function insertExercises(client, templateId, items) {
  for (const ex of items) {
    const { rows } = await client.query(
      `INSERT INTO workout_template_exercises
         (workout_template_id, exercise_name, target_sets, target_reps, target_weight_note,
          order_index, rest_seconds, notes, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [templateId, ex.exercise_name, ex.target_sets, ex.target_reps, ex.target_weight_note,
       ex.order_index, ex.rest_seconds, ex.notes, ex.group_id]
    );
    await insertForParent(client, 'workout_template_exercise_alternatives', rows[0].id, ex.alternatives || []);
  }
}

async function listTemplates(trainerId) {
  const { rows } = await query(
    `SELECT t.*, (
       SELECT COUNT(*) FROM workout_template_exercises e WHERE e.workout_template_id = t.id
     ) AS exercise_count
     FROM workout_templates t
     WHERE t.trainer_id = $1
     ORDER BY t.created_at DESC`,
    [trainerId]
  );
  return rows;
}

async function getTemplate(trainerId, id) {
  const { rows } = await query(
    'SELECT * FROM workout_templates WHERE id = $1 AND trainer_id = $2',
    [id, trainerId]
  );
  if (!rows.length) return null;
  const ex = await query(
    'SELECT * FROM workout_template_exercises WHERE workout_template_id = $1 ORDER BY order_index',
    [id]
  );
  const altMap = await fetchByParents(
    'workout_template_exercise_alternatives',
    'workout_template_exercise_id',
    ex.rows.map((r) => r.id)
  );
  rows[0].exercises = ex.rows.map((r) => ({ ...r, alternatives: altMap[r.id] || [] }));
  return rows[0];
}

async function updateTemplate(trainerId, id, { name, notes, tags, exercises }) {
  const existing = await getTemplate(trainerId, id);
  if (!existing) throw new HttpError(404, 'Template not found');
  if (!name || !String(name).trim()) throw new HttpError(400, 'name is required');
  const items = normalizeExercisesWithAlternatives(exercises);
  return transaction(async (client) => {
    await client.query(
      `UPDATE workout_templates SET name=$2, notes=$3, tags=$4, updated_at=now()
       WHERE id=$1`,
      [id, String(name).trim(), notes || null, Array.isArray(tags) ? tags.map(String) : []]
    );
    await client.query('DELETE FROM workout_template_exercises WHERE workout_template_id = $1', [id]);
    await insertExercises(client, id, items);
    return getTemplate(trainerId, id);
  });
}

async function deleteTemplate(trainerId, id) {
  // Safe by design: assignments are snapshots; source_template_id dangles
  // harmlessly (informational only).
  const { rowCount } = await query(
    'DELETE FROM workout_templates WHERE id = $1 AND trainer_id = $2',
    [id, trainerId]
  );
  if (!rowCount) throw new HttpError(404, 'Template not found');
}

// Assign a snapshot copy of the template to a client (active-association
// enforced). Copies every exercise field; stores source_template_id purely
// for traceability.
async function assignFromTemplate(trainerId, clientId, templateId) {
  await assertActiveAssociation(trainerId, clientId);
  const tpl = await getTemplate(trainerId, templateId);
  if (!tpl) throw new HttpError(404, 'Template not found');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO assigned_plans (trainer_id, client_id, name, notes, source_template_id, tags)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [trainerId, clientId, tpl.name, tpl.notes || null, tpl.id, tpl.tags || []]
    );
    const plan = rows[0];
    for (const ex of tpl.exercises) {
      const { rows: exRows } = await client.query(
        `INSERT INTO assigned_plan_exercises
           (assigned_plan_id, exercise_name, target_sets, target_reps, target_weight_note,
            order_index, rest_seconds, notes, group_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [plan.id, ex.exercise_name, ex.target_sets, ex.target_reps, ex.target_weight_note,
         ex.order_index, ex.rest_seconds, ex.notes, ex.group_id]
      );
      // SNAPSHOT the template's CURRENT alternatives into the assignment.
      // Later edits to the template never retroactively change this copy —
      // same snapshot-only rule as sets/reps/rest.
      await insertForParent(
        client,
        'assigned_plan_exercise_alternatives',
        exRows[0].id,
        (ex.alternatives || []).map((name, i) => ({ alternative_exercise_name: name, order_index: i }))
      );
    }
    return plan;
  });
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  assignFromTemplate,
};
