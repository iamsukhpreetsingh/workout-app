import { getDb } from './db';

export async function checkAndRecordPR(exerciseId, weight, reps, setId, sessionTime) {
  const db = await getDb();
  const results = [];

  const e1rm = weight * (1 + reps / 30);
  const volume = weight * reps;

  const prTypes = [
    { type: 'max_weight', value: weight, secondary: null },
    { type: 'estimated_1rm', value: e1rm, secondary: null },
    { type: 'max_volume_set', value: volume, secondary: weight },
    { type: 'max_reps_at_weight', value: reps, secondary: weight },
  ];

  for (const pr of prTypes) {
    const existing = await db.getFirstAsync(
      `SELECT * FROM personal_records WHERE exercise_id = ? AND record_type = ? AND secondary_value IS ?`,
      [exerciseId, pr.type, pr.secondary]
    );

    if (!existing || pr.value > existing.value) {
      if (existing) {
        await db.runAsync('DELETE FROM personal_records WHERE id = ?', [existing.id]);
      }

      await db.runAsync(
        `INSERT INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [exerciseId, pr.type, pr.value, pr.secondary, setId, new Date(sessionTime).toISOString()]
      );

      results.push({
        type: pr.type,
        oldValue: existing?.value || null,
        newValue: pr.value,
      });
    }
  }

  return results;
}

export async function getPRsForExercise(exerciseId) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM personal_records WHERE exercise_id = ? ORDER BY record_type, secondary_value`,
    [exerciseId]
  );

  const prs = {};
  for (const row of rows) {
    const key = row.secondary_value !== null 
      ? `${row.record_type}_${row.secondary_value}` 
      : row.record_type;
    prs[key] = row;
  }
  return prs;
}

export async function isSetAPR(setId) {
  const db = await getDb();
  const pr = await db.getFirstAsync('SELECT 1 FROM personal_records WHERE set_id = ?', [setId]);
  return !!pr;
}

// Read-only evaluation used for the in-session celebration (records are only
// written when the workout is saved). Returns the list of record types this
// set would break right now.
export async function evaluatePR(exerciseId, weight, reps) {
  const db = await getDb();
  const results = [];
  const e1rm = weight * (1 + reps / 30);
  const volume = weight * reps;
  const prTypes = [
    { type: 'max_weight', value: weight, secondary: null },
    { type: 'estimated_1rm', value: e1rm, secondary: null },
    { type: 'max_volume_set', value: volume, secondary: weight },
    { type: 'max_reps_at_weight', value: reps, secondary: weight },
  ];
  for (const pr of prTypes) {
    const existing = await db.getFirstAsync(
      `SELECT value FROM personal_records
       WHERE exercise_id = ? AND record_type = ? AND secondary_value IS ?`,
      [exerciseId, pr.type, pr.secondary]
    );
    if (!existing || pr.value > existing.value) {
      results.push({ type: pr.type, oldValue: existing?.value ?? null, newValue: pr.value });
    }
  }
  return results;
}

// All set_ids within a session that currently hold a record — for trophy badges.
export async function getPRSetIdsForSession(sessionId) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT DISTINCT pr.set_id FROM personal_records pr
     JOIN sets s ON pr.set_id = s.id
     JOIN session_exercises se ON s.session_exercise_id = se.id
     WHERE se.session_id = ?`,
    [sessionId]
  );
  return new Set(rows.map((r) => r.set_id));
}

// All set_ids for an exercise that currently hold a record.
export async function getPRSetIdsForExercise(exerciseId) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    'SELECT DISTINCT set_id FROM personal_records WHERE exercise_id = ?',
    [exerciseId]
  );
  return new Set(rows.map((r) => r.set_id));
}

export async function recomputePRsForExercise(exerciseId) {
  const db = await getDb();

  await db.runAsync('DELETE FROM personal_records WHERE exercise_id = ?', [exerciseId]);

  const sets = await db.getAllAsync(
    `SELECT s.id AS set_id, s.weight, s.reps, se.exercise_id, sess.start_time
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND s.set_type != 'warmup' AND s.completed = 1
     ORDER BY s.weight DESC, s.reps DESC`,
    [exerciseId]
  );

  const best = {
    max_weight: { value: 0, setId: null, time: null },
    estimated_1rm: { value: 0, setId: null, time: null },
    max_volume_set: { value: 0, weight: 0, setId: null, time: null },
  };

  const byWeight = {};

  for (const s of sets) {
    const e1rm = s.weight * (1 + s.reps / 30);
    const volume = s.weight * s.reps;

    if (s.weight > best.max_weight.value) {
      best.max_weight = { value: s.weight, setId: s.set_id, time: s.start_time };
    }
    if (e1rm > best.estimated_1rm.value) {
      best.estimated_1rm = { value: e1rm, setId: s.set_id, time: s.start_time };
    }
    if (volume > best.max_volume_set.value) {
      best.max_volume_set = { value: volume, weight: s.weight, setId: s.set_id, time: s.start_time };
    }

    if (!byWeight[s.weight]) {
      byWeight[s.weight] = { reps: 0, setId: null, time: null };
    }
    if (s.reps > byWeight[s.weight].reps) {
      byWeight[s.weight] = { reps: s.reps, setId: s.set_id, time: s.start_time };
    }
  }

  if (best.max_weight.setId) {
    await db.runAsync(
      `INSERT INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'max_weight', ?, NULL, ?, ?)`,
      [exerciseId, best.max_weight.value, best.max_weight.setId, new Date(best.max_weight.time).toISOString()]
    );
  }

  if (best.estimated_1rm.setId) {
    await db.runAsync(
      `INSERT INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'estimated_1rm', ?, NULL, ?, ?)`,
      [exerciseId, best.estimated_1rm.value, best.estimated_1rm.setId, new Date(best.estimated_1rm.time).toISOString()]
    );
  }

  if (best.max_volume_set.setId) {
    await db.runAsync(
      `INSERT INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'max_volume_set', ?, ?, ?, ?)`,
      [exerciseId, best.max_volume_set.value, best.max_volume_set.weight, best.max_volume_set.setId, new Date(best.max_volume_set.time).toISOString()]
    );
  }

  for (const [weight, data] of Object.entries(byWeight)) {
    if (data.setId) {
      await db.runAsync(
        `INSERT INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
         VALUES (?, 'max_reps_at_weight', ?, ?, ?, ?)`,
        [exerciseId, data.reps, parseFloat(weight), data.setId, new Date(data.time).toISOString()]
      );
    }
  }
}

export async function deleteSetAndRecompute(setId, exerciseId) {
  const db = await getDb();
  await db.runAsync('DELETE FROM personal_records WHERE set_id = ?', [setId]);
  await recomputePRsForExercise(exerciseId);
}