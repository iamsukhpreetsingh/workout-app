// Data access for session_exercise_details — the per-set drill-down layer
// on top of session_summaries. Sets are stored as JSONB and are STRUCTURAL
// only: {set_number, weight, reps, set_type, completed}. RPE and exercise
// notes are never accepted or stored here.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Upsert: replace-and-insert per summary (idempotent re-syncs)
// payload: array of { session_summary_id, exercises: [{exercise_name, order_index, sets: [...] }] }
async function upsertSessionDetails(clientId, payloads) {
  if (!Array.isArray(payloads) || !payloads.length) {
    throw new HttpError(400, 'Body must be a non-empty array of detail payloads');
  }
  // verify each summary belongs to the requesting client
  for (const p of payloads) {
    if (!p || !p.session_summary_id || !Array.isArray(p.exercises)) {
      throw new HttpError(400, 'Each payload requires session_summary_id and an exercises array');
    }
    const owner = await query('SELECT client_id FROM session_summaries WHERE id = $1', [
      p.session_summary_id,
    ]);
    if (!owner.rows.length || owner.rows[0].client_id !== clientId) {
      throw new HttpError(403, 'Session summary not found for this client');
    }
    // strip any client-supplied subjective fields defensively
    const clean = p.exercises.map((ex) => ({
      exercise_name: String(ex.exercise_name || ''),
      muscle_group: ex.muscle_group || null, // NULL for untagged customs — fine
      order_index: ex.order_index ?? 0,
      sets: (ex.sets || []).map((s) => ({
        set_number: s.set_number ?? null,
        weight: Number(s.weight) || 0,
        reps: Number(s.reps) || 0,
        set_type: s.set_type || 'working',
        completed: s.completed !== false,
      })),
    }));
    await query('DELETE FROM session_exercise_details WHERE session_summary_id = $1', [
      p.session_summary_id,
    ]);
    for (const ex of clean) {
      if (!ex.exercise_name) continue;
      await query(
        `INSERT INTO session_exercise_details (session_summary_id, exercise_name, muscle_group, order_index, sets)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [p.session_summary_id, ex.exercise_name, ex.muscle_group, ex.order_index, JSON.stringify(ex.sets)]
      );
    }
  }
  return { ok: true };
}

async function getDetailsForSummary(summaryId) {
  const { rows } = await query(
    `SELECT exercise_name, order_index, sets FROM session_exercise_details
     WHERE session_summary_id = $1 ORDER BY order_index`,
    [summaryId]
  );
  return rows;
}

// Distinct exercise names a client has actually logged (drives the Strength
// tab's picker — derived from synced detail, never hardcoded)
async function listClientExercises(clientId) {
  const { rows } = await query(
    `SELECT d.exercise_name, COUNT(*) AS set_count
     FROM session_exercise_details d
     JOIN session_summaries s ON s.id = d.session_summary_id
     WHERE s.client_id = $1
     GROUP BY d.exercise_name
     ORDER BY set_count DESC`,
    [clientId]
  );
  return rows;
}

// Best estimated 1RM (Epley) per session for one exercise over a range.
// Computed in SQL from the JSONB sets so the client only receives points.
async function strengthTrend(clientId, exerciseName, from, to) {
  const { rows } = await query(
    `SELECT s.performed_at,
            MAX((set_elem->>'weight')::numeric * (1 + (set_elem->>'reps')::numeric / 30.0)) AS best_e1rm
     FROM session_exercise_details d
     JOIN session_summaries s ON s.id = d.session_summary_id
     CROSS JOIN LATERAL jsonb_array_elements(d.sets) AS set_elem
     WHERE s.client_id = $1
       AND d.exercise_name = $2
       AND (set_elem->>'set_type')::text != 'warmup'
       AND ($3::date IS NULL OR s.performed_at::date >= $3)
       AND ($4::date IS NULL OR s.performed_at::date <= $4)
     GROUP BY s.id, s.performed_at
     ORDER BY s.performed_at ASC`,
    [clientId, exerciseName, from || null, to || null]
  );
  return rows;
}

// Volume grouped by muscle group over a range. Working/dropset/failure sets
// only (warmups excluded, consistent with all volume rules). NULL muscle
// groups are grouped into one row (muscle_group = NULL) so the client can
// render an "Untagged" bucket and totals reconcile — nothing is silently dropped.
async function volumeByMuscleGroup(clientId, from, to) {
  const { rows } = await query(
    `SELECT d.muscle_group,
            SUM((set_elem->>'weight')::numeric * (set_elem->>'reps')::numeric) AS volume
      FROM session_exercise_details d
      JOIN session_summaries s ON s.id = d.session_summary_id
      CROSS JOIN LATERAL jsonb_array_elements(d.sets) AS set_elem
      WHERE s.client_id = $1
        AND (set_elem->>'set_type')::text NOT IN ('warmup')
        AND ($2::date IS NULL OR s.performed_at::date >= $2)
        AND ($3::date IS NULL OR s.performed_at::date <= $3)
      GROUP BY d.muscle_group
      ORDER BY volume DESC`,
    [clientId, from || null, to || null]
  );
  return rows;
}

// List all session details for a client (for sync/pull)
async function listForClient(clientId) {
  const { rows } = await query(
    `SELECT s.local_session_id, d.exercise_name, d.muscle_group, d.order_index, d.sets
     FROM session_exercise_details d
     JOIN session_summaries s ON s.id = d.session_summary_id
     WHERE s.client_id = $1
     ORDER BY s.performed_at DESC, d.order_index ASC`,
    [clientId]
  );
  // Group by session
  const result = {};
  for (const row of rows) {
    if (!result[row.local_session_id]) {
      result[row.local_session_id] = [];
    }
    result[row.local_session_id].push({
      exercise_name: row.exercise_name,
      muscle_group: row.muscle_group,
      order_index: row.order_index,
      sets: row.sets,
    });
  }
  return result;
}

module.exports = {
  upsertSessionDetails,
  getDetailsForSummary,
  listClientExercises,
  strengthTrend,
  volumeByMuscleGroup,
  listForClient,
};
