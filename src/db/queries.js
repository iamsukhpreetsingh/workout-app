import { getDb } from './db';
import { checkAndRecordPR, recomputePRsForExercise } from './pr';
import { getCurrentUserId, setCurrentUserId } from './userId';

export { setCurrentUserId, getCurrentUserId };

// ---------- Exercises ----------
export async function listExercises() {
  const db = await getDb();
  return db.getAllAsync('SELECT * FROM exercises ORDER BY muscle_group, name');
}

export async function createExercise(name, muscleGroup) {
  const db = await getDb();
  const result = await db.runAsync(
    'INSERT INTO exercises (name, muscle_group, is_custom) VALUES (?, ?, 1)',
    [name.trim(), muscleGroup]
  );
  return result.lastInsertRowId;
}

export async function getExerciseHistory(exerciseId, limit = 50) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync(
    `SELECT s.id AS set_id, s.weight, s.reps, s.rpe, s.set_type,
            sess.id AS session_id, sess.name AS session_name, sess.start_time,
            se.id AS session_exercise_id
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1
     ORDER BY sess.start_time DESC, se.position ASC, s.position DESC
     LIMIT ?`,
    [exerciseId, userId, limit]
  );
}

export async function getExerciseBest(exerciseId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return { weight: 0, reps: 0 };
  const result = await db.getFirstAsync(
    `SELECT MAX(s.weight) AS max_weight, MAX(s.reps) AS max_reps
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1 AND s.weight > 0 AND s.reps > 0`,
    [exerciseId, userId]
  );
  return {
    weight: result?.max_weight || 0,
    reps: result?.max_reps || 0,
  };
}

// ---------- Plans ----------
export async function listPlans() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const plans = await db.getAllAsync(
    `SELECT p.*,
       (SELECT COUNT(*) FROM workout_sessions ws WHERE ws.plan_id = p.id AND ws.user_id = ?) AS used_count
     FROM workout_plans p WHERE p.user_id = ? ORDER BY p.created_at DESC`,
    [userId, userId]
  );
  for (const plan of plans) {
    plan.exerciseCount = (
      await db.getAllAsync('SELECT COUNT(*) AS c FROM plan_exercises WHERE plan_id = ?', [plan.id])
    )[0].c;
    plan.tags = plan.tags ? JSON.parse(plan.tags) : [];
  }
  return plans;
}

export async function getPlan(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  const plan = await db.getFirstAsync('SELECT * FROM workout_plans WHERE id = ? AND user_id = ?', [id, userId]);
  if (!plan) return null;
  plan.exercises = await db.getAllAsync(
    `SELECT pe.id, pe.target_sets, pe.position, pe.rest_seconds, pe.group_id,
            e.id AS exercise_id, e.name, e.muscle_group
     FROM plan_exercises pe
     JOIN exercises e ON pe.exercise_id = e.id
     WHERE pe.plan_id = ?
     ORDER BY pe.position`,
    [id]
  );
  
  for (const ex of plan.exercises) {
    const best = await db.getFirstAsync(
      `SELECT MAX(s.weight) AS max_weight, MAX(s.reps) AS max_reps
       FROM sets s
       JOIN session_exercises se ON s.session_exercise_id = se.id
       WHERE se.exercise_id = ? AND s.set_type != 'warmup' AND s.completed = 1 AND s.weight > 0 AND s.reps > 0`,
      [ex.exercise_id]
    );
    ex.bestWeight = best?.max_weight || 0;
    ex.bestReps = best?.max_reps || 0;
  }
  
  plan.tags = plan.tags ? JSON.parse(plan.tags) : [];
  return plan;
}

// exercises: [{ exerciseId, targetSets, restSeconds, groupId }]
// tags: optional array of strings (max 5)
export async function createPlan(name, notes, exercises, tags = []) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('User not authenticated');
  const tagsJson = JSON.stringify(tags.slice(0, 5));
  const result = await db.runAsync(
    'INSERT INTO workout_plans (name, notes, created_at, user_id, tags) VALUES (?, ?, ?, ?, ?)',
    [name, notes || null, Date.now(), userId, tagsJson]
  );
  const planId = result.lastInsertRowId;
  for (let i = 0; i < exercises.length; i++) {
    await db.runAsync(
      `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        planId,
        exercises[i].exerciseId,
        i,
        exercises[i].targetSets || 3,
        exercises[i].restSeconds || 90,
        exercises[i].groupId || null,
      ]
    );
  }
  return planId;
}

export async function deletePlan(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync('DELETE FROM workout_plans WHERE id = ? AND user_id = ?', [id, userId]);
}

export async function updatePlan(id, name, notes, exercises, tags = []) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('User not authenticated');
  const tagsJson = JSON.stringify(tags.slice(0, 5));
  await db.runAsync(
    'UPDATE workout_plans SET name = ?, notes = ?, tags = ? WHERE id = ? AND user_id = ?',
    [name, notes || null, tagsJson, id, userId]
  );
  await db.runAsync('DELETE FROM plan_exercises WHERE plan_id = ?', [id]);
  for (let i = 0; i < exercises.length; i++) {
    await db.runAsync(
      `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        exercises[i].exerciseId,
        i,
        exercises[i].targetSets || 3,
        exercises[i].restSeconds || 90,
        exercises[i].groupId || null,
      ]
    );
  }
  return id;
}

// ---------- Sessions ----------
const SESSION_TOTALS = `
  SELECT COALESCE(SUM(s.weight * s.reps), 0) AS v, COUNT(s.id) AS c
  FROM sets s
  JOIN session_exercises se ON s.session_exercise_id = se.id
  WHERE se.session_id = ? AND s.set_type != 'warmup' AND s.completed = 1`;

export async function listSessions() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const sessions = await db.getAllAsync(
    'SELECT * FROM workout_sessions WHERE user_id = ? ORDER BY start_time DESC',
    [userId]
  );
  for (const s of sessions) {
    const totals = (await db.getAllAsync(SESSION_TOTALS, [s.id]))[0];
    s.totalVolume = totals.v;
    s.totalSets = totals.c;
    s.exerciseCount = (
      await db.getAllAsync(
        'SELECT COUNT(*) AS c FROM session_exercises WHERE session_id = ?',
        [s.id]
      )
    )[0].c;
  }
  return sessions;
}

export async function getSession(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  const session = await db.getFirstAsync('SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  if (!session) return null;
  const exercises = await db.getAllAsync(
    `SELECT se.id AS session_exercise_id, se.position, se.rest_seconds, se.group_id, se.notes,
            e.id AS exercise_id, e.name, e.muscle_group
     FROM session_exercises se
     JOIN exercises e ON se.exercise_id = e.id
     WHERE se.session_id = ?
     ORDER BY se.position`,
    [id]
  );
  for (const ex of exercises) {
    ex.sets = await db.getAllAsync(
      'SELECT * FROM sets WHERE session_exercise_id = ? ORDER BY position',
      [ex.session_exercise_id]
    );
  }
  session.exercises = exercises;
  return session;
}

// session: { id?, name, start_time, end_time, duration_sec, notes, plan_id,
//            exercises: [{ exerciseId, restSeconds, groupId, notes,
//                          sets: [{ weight, reps, rpe, setType, completed }] }] }
export async function saveSession(session) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('User not authenticated');
  let sessionId = session.id;
  if (sessionId) {
    await db.runAsync('DELETE FROM session_exercises WHERE session_id = ?', [sessionId]);
    await db.runAsync(
      `UPDATE workout_sessions SET name = ?, end_time = ?, duration_sec = ?, notes = ?
       WHERE id = ? AND user_id = ?`,
      [session.name, session.end_time, session.duration_sec, session.notes || null, sessionId, userId]
    );
  } else {
    const result = await db.runAsync(
      `INSERT INTO workout_sessions (name, start_time, end_time, duration_sec, notes, plan_id, source_assigned_plan_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.name, session.start_time, session.end_time, session.duration_sec, session.notes || null, session.plan_id || null, session.sourceAssignedPlanId || null, userId]
    );
    sessionId = result.lastInsertRowId;
  }
  for (let i = 0; i < session.exercises.length; i++) {
    const ex = session.exercises[i];
    const r = await db.runAsync(
      `INSERT INTO session_exercises (session_id, exercise_id, position, rest_seconds, group_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, ex.exerciseId, i, ex.restSeconds || 90, ex.groupId || null, ex.notes || null]
    );
    const seId = r.lastInsertRowId;
    for (let j = 0; j < ex.sets.length; j++) {
      const set = ex.sets[j];
      const inserted = await db.runAsync(
        `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, rpe, set_type, completed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seId,
          set.weight || 0,
          set.reps || 0,
          set.setType === 'warmup' ? 1 : 0,
          j,
          set.rpe ?? null,
          set.setType || 'working',
          set.completed === 0 ? 0 : 1,
        ]
      );
      // PRs only for completed, non-warmup sets with real values
      if (
        set.completed !== 0 &&
        (set.setType || 'working') !== 'warmup' &&
        (set.weight || 0) > 0 &&
        (set.reps || 0) > 0
      ) {
        await checkAndRecordPR(
          ex.exerciseId,
          set.weight,
          set.reps,
          inserted.lastInsertRowId,
          session.start_time
        );
      }
    }
  }
  return sessionId;
}

export async function updateSessionName(sessionId, newName) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    'UPDATE workout_sessions SET name = ?, synced = 0 WHERE id = ? AND user_id = ?',
    [newName.trim(), sessionId, userId]
  );
}

export async function deleteSession(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const exerciseIds = (
    await db.getAllAsync(
      'SELECT DISTINCT exercise_id FROM session_exercises WHERE session_id = ?',
      [id]
    )
  ).map((r) => r.exercise_id);
  await db.runAsync('DELETE FROM workout_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  // Deleted sets may have held records — demote to the next-best historical set
  for (const exId of exerciseIds) {
    await recomputePRsForExercise(exId);
  }
}

// Retroactive set type change (history/session edit). Stats are derived at
// query time, so recalculating a session happens automatically — but PRs are
// stored, so they must be recomputed if a set is reclassified as a warm-up.
export async function updateSetType(setId, setType) {
  const db = await getDb();
  const userId = getCurrentUserId();
  const row = await db.getFirstAsync(
    `SELECT se.exercise_id, se.session_id FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     WHERE s.id = ?`,
    [setId]
  );
  await db.runAsync('UPDATE sets SET set_type = ? WHERE id = ?', [setType, setId]);
  if (row) await recomputePRsForExercise(row.exercise_id);
  // A retroactive type change alters the session's aggregates — flag the
  // session for re-sync so the trainer-facing summary reflects the fix.
  if (row && userId) {
    await db.runAsync('UPDATE workout_sessions SET synced = 0 WHERE id = ? AND user_id = ?', [row.session_id, userId]);
  }
}

// ---------- Progress ----------
export async function getProgressOverview() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync(
    `SELECT sess.id, sess.name, sess.start_time, sess.end_time, sess.duration_sec,
            COALESCE(SUM(s.weight * s.reps), 0) AS volume,
            COUNT(DISTINCT se.exercise_id) AS exercise_count,
            COUNT(s.id) AS set_count
     FROM workout_sessions sess
     LEFT JOIN session_exercises se ON se.session_id = sess.id
     LEFT JOIN sets s ON s.session_exercise_id = se.id AND s.set_type != 'warmup' AND s.completed = 1
     WHERE sess.user_id = ?
     GROUP BY sess.id
     ORDER BY sess.start_time ASC`,
    [userId]
  );
}

export async function getExerciseProgressList() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync(
    `SELECT e.id, e.name, e.muscle_group,
            COUNT(DISTINCT sess.id) AS session_count,
            MAX(s.weight) AS best_weight,
            MAX(s.reps) AS best_reps,
            MAX(s.weight * (1 + s.reps / 30.0)) AS best_e1rm
     FROM exercises e
     JOIN session_exercises se ON se.exercise_id = e.id
     JOIN sets s ON s.session_exercise_id = se.id AND s.set_type != 'warmup' AND s.completed = 1
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE sess.user_id = ?
     GROUP BY e.id
     ORDER BY session_count DESC`,
    [userId]
  );
}

export async function getExerciseProgress(exerciseId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync(
    `SELECT sess.start_time,
            MAX(s.weight) AS max_weight,
            MAX(s.weight * (1 + s.reps / 30.0)) AS best_e1rm,
            SUM(s.weight * s.reps) AS volume,
            COUNT(s.id) AS set_count,
            AVG(s.rpe) AS avg_rpe
     FROM workout_sessions sess
     JOIN session_exercises se ON se.session_id = sess.id AND se.exercise_id = ?
     JOIN sets s ON s.session_exercise_id = se.id AND s.set_type != 'warmup' AND s.completed = 1
     WHERE sess.user_id = ?
     GROUP BY sess.id
     ORDER BY sess.start_time ASC`,
    [exerciseId, userId]
  );
}

export async function getPersonalRecords(exerciseId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return { maxWeight: 0, maxReps: 0, bestE1rm: 0, totalVolume: 0 };
  const base = `FROM sets s
       JOIN session_exercises se ON s.session_exercise_id = se.id
       JOIN workout_sessions sess ON se.session_id = sess.id
       WHERE se.exercise_id = ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1`;
  return {
    maxWeight: (await db.getFirstAsync(`SELECT MAX(s.weight) AS v ${base}`, [exerciseId, userId])).v,
    maxReps: (await db.getFirstAsync(`SELECT MAX(s.reps) AS v ${base}`, [exerciseId, userId])).v,
    bestE1rm: (await db.getFirstAsync(`SELECT MAX(s.weight * (1 + s.reps / 30.0)) AS v ${base}`, [exerciseId, userId])).v,
    totalVolume: (await db.getFirstAsync(`SELECT COALESCE(SUM(s.weight * s.reps), 0) AS v ${base}`, [exerciseId, userId])).v,
  };
}

// Recent sets (working only) for the RPE insight on the progress screen
export async function getRecentSets(exerciseId, limit = 10) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync(
    `SELECT s.weight, s.reps, s.rpe
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1
     ORDER BY s.id DESC
     LIMIT ?`,
    [exerciseId, userId, limit]
  );
}

// ---------- Session-summary sync (aggregate-only) ----------
// Aggregates follow the app's volume rules everywhere: exclude warmup sets
// and sets not marked completed.

// Aggregate payload for one session, in the backend's summary shape
export async function getSessionSyncAggregate(sessionId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  const session = await db.getFirstAsync(
    'SELECT id, name, start_time, duration_sec FROM workout_sessions WHERE id = ? AND user_id = ?',
    [sessionId, userId]
  );
  if (!session) return null;
  const agg = await db.getFirstAsync(
    `SELECT COUNT(DISTINCT se.exercise_id) AS exercise_count,
            COUNT(s.id) AS working_set_count,
            COALESCE(SUM(s.weight * s.reps), 0) AS total_volume
     FROM session_exercises se
     LEFT JOIN sets s ON s.session_exercise_id = se.id
       AND s.set_type != 'warmup' AND s.completed = 1
     WHERE se.session_id = ?`,
    [sessionId]
  );
  return {
    local_session_id: String(session.id),
    name: session.name,
    performed_at: new Date(session.start_time).toISOString(),
    duration_seconds: session.duration_sec ?? null,
    exercise_count: agg.exercise_count || 0,
    working_set_count: agg.working_set_count || 0,
    total_volume: agg.total_volume || 0,
  };
}

export async function getUnsyncedSessionIds() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = await db.getAllAsync(
    'SELECT id FROM workout_sessions WHERE synced = 0 AND user_id = ? ORDER BY start_time ASC',
    [userId]
  );
  return rows.map((r) => r.id);
}

export async function markSessionsSynced(sessionIds) {
  if (!sessionIds.length) return;
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const placeholders = sessionIds.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE workout_sessions SET synced = 1, sync_attempted_at = ? WHERE id IN (${placeholders}) AND user_id = ?`,
    [new Date().toISOString(), ...sessionIds, userId]
  );
}

export async function markSessionSyncAttempted(sessionId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    'UPDATE workout_sessions SET sync_attempted_at = ? WHERE id = ? AND user_id = ?',
    [new Date().toISOString(), sessionId, userId]
  );
}

// Per-set drill-down payload for one session. STRUCTURAL ONLY: weight,
// reps, set_type, completed. RPE and notes are deliberately never included.
export async function getSessionExerciseDetailPayload(sessionId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  const session = await db.getFirstAsync(
    'SELECT id FROM workout_sessions WHERE id = ? AND user_id = ?',
    [sessionId, userId]
  );
  if (!session) return null;
  const exercises = await db.getAllAsync(
    `SELECT e.name AS exercise_name, e.muscle_group, se.position AS order_index
     FROM session_exercises se
     JOIN exercises e ON e.id = se.exercise_id
     WHERE se.session_id = ?
     ORDER BY se.position`,
    [sessionId]
  );
  for (const ex of exercises) {
    const sets = await db.getAllAsync(
      'SELECT position, weight, reps, set_type, completed FROM sets WHERE session_exercise_id IN (SELECT id FROM session_exercises WHERE session_id = ? AND position = ?) ORDER BY position',
      [sessionId, ex.order_index]
    );
    ex.sets = sets.map((s, i) => ({
      set_number: i + 1,
      weight: s.weight || 0,
      reps: s.reps || 0,
      set_type: s.set_type || 'working',
      completed: s.completed !== 0,
    }));
  }
  return { local_session_id: String(sessionId), exercises };
}

export async function getPendingSyncCount() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return 0;
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM workout_sessions WHERE synced = 0 AND user_id = ?', [userId]);
  return row.c;
}
