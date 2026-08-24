import { getDb } from './db';
import { checkAndRecordPR, recomputePRsForExercise } from './pr';
import { getCurrentUserId, setCurrentUserId } from './userId';
// import { addToSyncQueue, ENTITY_TYPES, syncPending } from '../lib/sync';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

export { setCurrentUserId, getCurrentUserId };



// Any code path that creates or recomputes PRs calls this afterwards: all
// unsynced PR rows are swept into the backup queue in one go.
async function enqueueUnsyncedPRs() {
  const db = await getDb();
  const rows = await db.getAllAsync('SELECT id FROM personal_records WHERE synced = 0');
  for (const r of rows) {
    await enqueueUpsert('personal_record', String(r.id));
  }
}



// // ---------- Exercises ----------
// export async function listExercises() {
//   const db = await getDb();
//   return db.getAllAsync('SELECT * FROM exercises ORDER BY muscle_group, name');
// }


export async function listExercises() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  // seeds (user_id NULL) are device-shared; customs are account-scoped
  return db.getAllAsync(
    `SELECT * FROM exercises WHERE user_id IS NULL OR user_id = ? ORDER BY muscle_group, name`,
    [userId]
  );
}


// export async function createExercise(name, muscleGroup) {
//   const db = await getDb();
//   const result = await db.runAsync(
//     'INSERT INTO exercises (name, muscle_group, is_custom) VALUES (?, ?, 1)',
//     [name.trim(), muscleGroup]
//   );
//   return result.lastInsertRowId;
// }


// export async function createExercise(name, muscleGroup) {
//   const db = await getDb();
//   const result = await db.runAsync(
//     'INSERT INTO exercises (name, muscle_group, is_custom) VALUES (?, ?, 1)',
//     [name.trim(), muscleGroup]
//   );
//   // custom exercises are real user data — queue the backup (the old system
//   // never synced these, which corrupted restores on fresh devices)
//   await enqueueUpsert('custom_exercise', String(result.lastInsertRowId));
//   return result.lastInsertRowId;
// }



// export async function createExercise(name, muscleGroup) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) throw new Error('User not authenticated');
//   const trimmed = name.trim();
//   const clash = await db.getFirstAsync('SELECT id FROM exercises WHERE name = ?', [trimmed]);
//   if (clash) throw new Error(`An exercise named "${trimmed}" already exists`);
//   const result = await db.runAsync(
//     'INSERT INTO exercises (name, muscle_group, is_custom, user_id) VALUES (?, ?, 1, ?)',
//     [trimmed, muscleGroup, userId]
//   );
//   await enqueueUpsert('custom_exercise', String(result.lastInsertRowId));
//   return result.lastInsertRowId;
// }



// Resolve a full enriched exercise record by name — used where rows carry
// only a name (trainer templates/assignments store names, not ids).
export async function getExerciseByName(name) {
  const db = await getDb();
  return db.getFirstAsync('SELECT * FROM exercises WHERE name = ?', [name]);
}


// Set/clear an exercise's training max (percentage-based progression input).
// Local-only by design (library exercises are device-global; customs sync
// through their own backup entity) — documented limitation.
export async function setExerciseTrainingMax(exerciseId, value) {
  const db = await getDb();
  const v = value == null || value === '' || isNaN(Number(value)) ? null : Number(value);
  await db.runAsync('UPDATE exercises SET training_max = ? WHERE id = ?', [v, exerciseId]);
  return v;
}


export async function createExercise(name, muscleGroup, extra = {}) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('User not authenticated');
  const trimmed = name.trim();
  const clash = await db.getFirstAsync('SELECT id FROM exercises WHERE name = ?', [trimmed]);
  if (clash) throw new Error(`An exercise named "${trimmed}" already exists`);
  // optional enrichment fields — instructions stored as {en: text} to match
  // the library's multilingual format
  const instructions = extra.instructions?.trim()
    ? JSON.stringify({ en: extra.instructions.trim() })
    : null;
  const result = await db.runAsync(
    `INSERT INTO exercises (name, muscle_group, is_custom, user_id, equipment, body_part, instructions)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [trimmed, muscleGroup, userId, extra.equipment?.trim() || null, null, instructions]
  );
  await enqueueUpsert('custom_exercise', String(result.lastInsertRowId));
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

// Most recent PRIOR session containing this exercise, its sets ordered by
// position ASC — used for PER-SET POSITIONAL prefill ("last time" hints).
// Sets are matched by set POSITION (order_index), never by "the last set
// overall": each current-session set position shows ITS OWN prior value.
// Blank rows (nothing logged, not completed) are excluded; set_type is NOT
// filtered here — the placeholder is a memory aid, not a validation.
export async function getLastSessionSetsByPosition(exerciseId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const row = await db.getFirstAsync(
    `SELECT sess.id AS session_id
     FROM workout_sessions sess
     JOIN session_exercises se ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND sess.user_id = ?
     ORDER BY sess.start_time DESC
     LIMIT 1`,
    [exerciseId, userId]
  );
  if (!row) return [];
  return db.getAllAsync(
    `SELECT s.weight, s.reps, s.rpe, s.set_type, s.completed, s.position
     FROM sets s
     WHERE s.session_exercise_id IN (
             SELECT id FROM session_exercises WHERE session_id = ? AND exercise_id = ?
           )
       AND (s.completed = 1 OR s.weight > 0 OR s.reps > 0)
     ORDER BY s.position ASC`,
    [row.session_id, exerciseId]
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
            e.id AS exercise_id, e.name, e.muscle_group, e.equipment, e.body_part,
            e.target, e.secondary_muscles, e.instructions, e.instruction_steps,
            e.media_id, e.gif_url, e.attribution, e.is_custom, e.training_max
     FROM plan_exercises pe
     JOIN exercises e ON pe.exercise_id = e.id
     WHERE pe.plan_id = ?
     ORDER BY pe.position`,
    [id]
  );
  // configured alternatives (0-3 per entry) for the live-swap picker
  const altRows = await db.getAllAsync(
    `SELECT plan_exercise_id, alternative_exercise_name, alternative_exercise_id_local
     FROM plan_exercise_alternatives ORDER BY order_index`
  );
  const altByParent = {};
  for (const a of altRows) {
    (altByParent[a.plan_exercise_id] = altByParent[a.plan_exercise_id] || []).push({
      name: a.alternative_exercise_name,
      exerciseId: a.alternative_exercise_id_local ? Number(a.alternative_exercise_id_local) : null,
    });
  }
  for (const ex of plan.exercises) ex.alternatives = altByParent[String(ex.id)] || [];
  
  for (const ex of plan.exercises) {
    // Positional prior-session sets for per-set prefill (falls back to
    // bestWeight/bestReps only when no history exists)
    ex.prevSets = await getLastSessionSetsByPosition(ex.exercise_id);
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

// // exercises: [{ exerciseId, targetSets, restSeconds, groupId }]
// // tags: optional array of strings (max 5)
// export async function createPlan(name, notes, exercises, tags = []) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) throw new Error('User not authenticated');
//   const tagsJson = JSON.stringify(tags.slice(0, 5));
//   const result = await db.runAsync(
//     'INSERT INTO workout_plans (name, notes, created_at, user_id, tags) VALUES (?, ?, ?, ?, ?)',
//     [name, notes || null, Date.now(), userId, tagsJson]
//   );
//   const planId = result.lastInsertRowId;
//   for (let i = 0; i < exercises.length; i++) {
//     await db.runAsync(
//       `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [
//         planId,
//         exercises[i].exerciseId,
//         i,
//         exercises[i].targetSets || 3,
//         exercises[i].restSeconds || 90,
//         exercises[i].groupId || null,
//       ]
//     );
//   }
  
//   // Add to sync queue
//   await addToSyncQueue(ENTITY_TYPES.WORKOUT_PLAN, String(planId), 'CREATE', {
//     local_plan_id: String(planId),
//     name,
//     notes: notes || null,
//     exercises: exercises.map((e, i) => ({
//       exercise_id: e.exerciseId,
//       target_sets: e.targetSets || 3,
//       rest_seconds: e.restSeconds || 90,
//       order_index: i,
//     })),
//     tags,
//     created_at: new Date().toISOString(),
//     updated_at: new Date().toISOString(),
//   });
  
//   return planId;
// }


// exercises: [{ exerciseId, targetSets, restSeconds, groupId, alternatives }]
// alternatives: 0-3 entries [{ name, exerciseId? }] — validated client-side
// by AlternativesEditor; re-validated here (cap + duplicates).
function normalizeAlternatives(exerciseId, primaryName, alternatives = []) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const seen = new Set([norm(primaryName)]);
  const out = [];
  for (const a of alternatives) {
    // builders pass plain strings; some flows pass {name} objects
    const name = String(typeof a === 'string' ? a : a?.name || '').trim();
    if (!name) continue;
    if (out.length >= 3) throw new Error('Up to 3 alternatives per exercise');
    if (seen.has(norm(name))) throw new Error(`"${name}" is already added as an alternative`);
    seen.add(norm(name));
    out.push({ name, exerciseId: typeof a === 'object' ? a.exerciseId ?? null : null });
  }
  return out;
}

// Insert one plan_exercises row plus its configured alternatives.
async function insertPlanExercise(db, planId, ex, i) {
  const r = await db.runAsync(
    `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      planId,
      ex.exerciseId,
      i,
      ex.targetSets || 3,
      ex.restSeconds || 90,
      ex.groupId || null,
    ]
  );
  const primaryName = ex.name || null;
  for (const [j, alt] of normalizeAlternatives(ex.exerciseId, primaryName, ex.alternatives).entries()) {
    await db.runAsync(
      `INSERT INTO plan_exercise_alternatives
         (plan_exercise_id, alternative_exercise_name, alternative_exercise_id_local, order_index)
       VALUES (?, ?, ?, ?)`,
      [String(r.lastInsertRowId), alt.name, alt.exerciseId != null ? String(alt.exerciseId) : null, j]
    );
  }
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
    await insertPlanExercise(db, planId, exercises[i], i);
  }

  // queue the backup — the engine builds the payload fresh at upload time
  await enqueueUpsert('workout_plan', String(planId));

  return planId;
}


// export async function deletePlan(id) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) return;
  
//   // Get plan details before delete for sync
//   const plan = await db.getFirstAsync('SELECT * FROM workout_plans WHERE id = ? AND user_id = ?', [id, userId]);
  
//   await db.runAsync('DELETE FROM workout_plans WHERE id = ? AND user_id = ?', [id, userId]);
  
//   // Add to sync queue for delete
//   if (plan) {
//     await addToSyncQueue(ENTITY_TYPES.WORKOUT_PLAN, String(id), 'DELETE', {
//       local_plan_id: String(id),
//     });
//   }
// }


export async function deletePlan(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;

  // capture backup state BEFORE the row disappears
  const plan = await db.getFirstAsync(
    'SELECT server_id FROM workout_plans WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  await db.runAsync('DELETE FROM workout_plans WHERE id = ? AND user_id = ?', [id, userId]);
  // alternatives are keyed by plan_exercise id with no FK — sweep orphans
  await db.runAsync(
    `DELETE FROM plan_exercise_alternatives WHERE plan_exercise_id NOT IN (
       SELECT CAST(pe.id AS TEXT) FROM plan_exercises pe
     )`
  );

  // server delete only if it was ever backed up; never-synced deletes are
  // clean local removals (no queue row, no server call — no 404 loops)
  await enqueueDelete('workout_plan', String(id), !!plan?.server_id);
}


// export async function updatePlan(id, name, notes, exercises, tags = []) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) throw new Error('User not authenticated');
//   const tagsJson = JSON.stringify(tags.slice(0, 5));
//   await db.runAsync(
//     'UPDATE workout_plans SET name = ?, notes = ?, tags = ? WHERE id = ? AND user_id = ?',
//     [name, notes || null, tagsJson, id, userId]
//   );
//   await db.runAsync('DELETE FROM plan_exercises WHERE plan_id = ?', [id]);
//   for (let i = 0; i < exercises.length; i++) {
//     await db.runAsync(
//       `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [
//         id,
//         exercises[i].exerciseId,
//         i,
//         exercises[i].targetSets || 3,
//         exercises[i].restSeconds || 90,
//         exercises[i].groupId || null,
//       ]
//     );
//   }
  
//   // Add to sync queue
//   await addToSyncQueue(ENTITY_TYPES.WORKOUT_PLAN, String(id), 'UPDATE', {
//     local_plan_id: String(id),
//     name,
//     notes: notes || null,
//     exercises: exercises.map((e, i) => ({
//       exercise_id: e.exerciseId,
//       target_sets: e.targetSets || 3,
//       rest_seconds: e.restSeconds || 90,
//       order_index: i,
//     })),
//     tags,
//     updated_at: new Date().toISOString(),
//   });
  
//   return id;
// }




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
  await db.runAsync(
    `DELETE FROM plan_exercise_alternatives WHERE plan_exercise_id NOT IN (
       SELECT CAST(pe.id AS TEXT) FROM plan_exercises pe
     )`
  );
  for (let i = 0; i < exercises.length; i++) {
    await insertPlanExercise(db, id, exercises[i], i);
  }

  // queue the edit — engine rebuilds the payload fresh
  await enqueueUpsert('workout_plan', String(id));

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
    // `SELECT se.id AS session_exercise_id, se.position, se.rest_seconds, se.group_id, se.notes,
    //         e.id AS exercise_id, e.name, e.muscle_group
    //  FROM session_exercises se
        `SELECT se.id AS session_exercise_id, se.position, se.rest_seconds, se.group_id, se.notes,
            se.original_exercise_name,
            e.id AS exercise_id, e.name, e.muscle_group, e.equipment, e.body_part,
            e.target, e.secondary_muscles, e.instructions, e.instruction_steps,
            e.media_id, e.gif_url, e.attribution, e.is_custom, e.training_max
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

// // session: { id?, name, start_time, end_time, duration_sec, notes, plan_id,
// //            exercises: [{ exerciseId, restSeconds, groupId, notes,
// //                          sets: [{ weight, reps, rpe, setType, completed }] }] }
// export async function saveSession(session) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) throw new Error('User not authenticated');
//   let sessionId = session.id;
//   if (sessionId) {
//     await db.runAsync('DELETE FROM session_exercises WHERE session_id = ?', [sessionId]);
//     await db.runAsync(
//       `UPDATE workout_sessions SET name = ?, end_time = ?, duration_sec = ?, notes = ?, synced = 0
//        WHERE id = ? AND user_id = ?`,
//       [session.name, session.end_time, session.duration_sec, session.notes || null, sessionId, userId]
//     );
//     // Add to sync queue for update
//     await addToSyncQueue(ENTITY_TYPES.SESSION, String(sessionId), 'UPDATE', {
//       local_session_id: String(sessionId),
//       name: session.name,
//       performed_at: new Date(session.start_time).toISOString(),
//       duration_seconds: session.duration_sec,
//     });
//   } else {
//     const result = await db.runAsync(
//       `INSERT INTO workout_sessions (name, start_time, end_time, duration_sec, notes, plan_id, source_assigned_plan_id, user_id, synced)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
//       [session.name, session.start_time, session.end_time, session.duration_sec, session.notes || null, session.plan_id || null, session.sourceAssignedPlanId || null, userId]
//     );
//     sessionId = result.lastInsertRowId;
    
//     // Add to sync queue for create
//     await addToSyncQueue(ENTITY_TYPES.SESSION, String(sessionId), 'CREATE', {
//       local_session_id: String(sessionId),
//       name: session.name,
//       performed_at: new Date(session.start_time).toISOString(),
//       duration_seconds: session.duration_sec,
//       exercise_count: session.exercises?.length || 0,
//     });
//   }
//   for (let i = 0; i < session.exercises.length; i++) {
//     const ex = session.exercises[i];
//     const r = await db.runAsync(
//       `INSERT INTO session_exercises (session_id, exercise_id, position, rest_seconds, group_id, notes)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [sessionId, ex.exerciseId, i, ex.restSeconds || 90, ex.groupId || null, ex.notes || null]
//     );
//     const seId = r.lastInsertRowId;
//     for (let j = 0; j < ex.sets.length; j++) {
//       const set = ex.sets[j];
//       const inserted = await db.runAsync(
//         `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, rpe, set_type, completed)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           seId,
//           set.weight || 0,
//           set.reps || 0,
//           set.setType === 'warmup' ? 1 : 0,
//           j,
//           set.rpe ?? null,
//           set.setType || 'working',
//           set.completed === 0 ? 0 : 1,
//         ]
//       );
//       // PRs only for completed, non-warmup sets with real values
//       if (
//         set.completed !== 0 &&
//         (set.setType || 'working') !== 'warmup' &&
//         (set.weight || 0) > 0 &&
//         (set.reps || 0) > 0
//       ) {
//         await checkAndRecordPR(
//           ex.exerciseId,
//           set.weight,
//           set.reps,
//           inserted.lastInsertRowId,
//           session.start_time
//         );
//       }
//     }
//   }
//   return sessionId;
// }



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
      `UPDATE workout_sessions SET name = ?, end_time = ?, duration_sec = ?, notes = ?, synced = 0
       WHERE id = ? AND user_id = ?`,
      [session.name, session.end_time, session.duration_sec, session.notes || null, sessionId, userId]
    );
  } else {
    const result = await db.runAsync(
      `INSERT INTO workout_sessions (name, start_time, end_time, duration_sec, notes, plan_id, source_assigned_plan_id, user_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [session.name, session.start_time, session.end_time, session.duration_sec, session.notes || null, session.plan_id || null, session.sourceAssignedPlanId || null, userId]
    );
    sessionId = result.lastInsertRowId;
  }
  for (let i = 0; i < session.exercises.length; i++) {
    const ex = session.exercises[i];
    const r = await db.runAsync(
      `INSERT INTO session_exercises (session_id, exercise_id, position, rest_seconds, group_id, notes, original_exercise_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, ex.exerciseId, i, ex.restSeconds || 90, ex.groupId || null, ex.notes || null, ex.originalExerciseName || null]
    );
    const seId = r.lastInsertRowId;
    for (let j = 0; j < ex.sets.length; j++) {
      const set = ex.sets[j];
      const inserted = await db.runAsync(
        // `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, rpe, set_type, completed)
        //  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        // [
        //   seId,
        //   set.weight || 0,
        //   set.reps || 0,
        //   set.setType === 'warmup' ? 1 : 0,
        //   j,
        //   set.rpe ?? null,
        //   set.setType || 'working',
        //   set.completed === 0 ? 0 : 1,
        // ]

        `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, rpe, set_type, completed, suggested_weight, suggested_reps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seId,
          set.weight || 0,
          set.reps || 0,
          set.setType === 'warmup' ? 1 : 0,
          j,
          set.rpe ?? null,
          set.setType || 'working',
          set.completed === 0 ? 0 : 1,
          set.suggestedWeight ?? null,
          set.suggestedReps ?? null,
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

  // Queue the full-fidelity backup AFTER all exercises/sets/PRs are written
  // so the engine's fresh payload build sees the complete session. (The
  // redacted trainer-facing summary push is a separate system and continues
  // unchanged.) The old code queued a degraded payload here — the root cause
  // of the server-side zeroing bug; that path is gone.
  await enqueueUpsert('session', String(sessionId));
  await enqueueUnsyncedPRs();

  return sessionId;
}


// export async function updateSessionName(sessionId, newName) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) return;
//   await db.runAsync(
//     'UPDATE workout_sessions SET name = ?, synced = 0 WHERE id = ? AND user_id = ?',
//     [newName.trim(), sessionId, userId]
//   );
//   // Add to sync queue for update
//   await addToSyncQueue(ENTITY_TYPES.SESSION, String(sessionId), 'UPDATE', {
//     local_session_id: String(sessionId),
//     name: newName.trim(),
//   });
//   // Trigger immediate sync attempt
//   syncPending().catch(e => console.log('[SYNC] Background sync failed:', e.message));
// }


export async function updateSessionName(sessionId, newName) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    'UPDATE workout_sessions SET name = ?, synced = 0 WHERE id = ? AND user_id = ?',
    [newName.trim(), sessionId, userId]
  );
  // queue the rename — the engine uploads fresh data when due
  await enqueueUpsert('session', String(sessionId));
}


// export async function deleteSession(id) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   if (!userId) return;
//   const exerciseIds = (
//     await db.getAllAsync(
//       'SELECT DISTINCT exercise_id FROM session_exercises WHERE session_id = ?',
//       [id]
//     )
//   ).map((r) => r.exercise_id);
//   await db.runAsync('DELETE FROM workout_sessions WHERE id = ? AND user_id = ?', [id, userId]);
//   // Deleted sets may have held records — demote to the next-best historical set
//   for (const exId of exerciseIds) {
//     await recomputePRsForExercise(exId);
//   }
// }



export async function deleteSession(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;

  // capture backup state BEFORE the row disappears
  const row = await db.getFirstAsync(
    'SELECT server_id FROM workout_sessions WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  const hadServerBackup = !!row?.server_id;

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

  // server-side backup delete (idempotent) — only if it was ever backed up.
  // This is what stops deleted workouts from resurrecting on a fresh install.
  await enqueueDelete('session', String(id), hadServerBackup);
  await enqueueUnsyncedPRs();
}


// // Retroactive set type change (history/session edit). Stats are derived at
// // query time, so recalculating a session happens automatically — but PRs are
// // stored, so they must be recomputed if a set is reclassified as a warm-up.
// export async function updateSetType(setId, setType) {
//   const db = await getDb();
//   const userId = getCurrentUserId();
//   const row = await db.getFirstAsync(
//     `SELECT se.exercise_id, se.session_id FROM sets s
//      JOIN session_exercises se ON s.session_exercise_id = se.id
//      WHERE s.id = ?`,
//     [setId]
//   );
//   await db.runAsync('UPDATE sets SET set_type = ? WHERE id = ?', [setType, setId]);
//   if (row) await recomputePRsForExercise(row.exercise_id);
//   // A retroactive type change alters the session's aggregates — flag the
//   // session for re-sync so the trainer-facing summary reflects the fix.
//   if (row && userId) {
//     await db.runAsync('UPDATE workout_sessions SET synced = 0 WHERE id = ? AND user_id = ?', [row.session_id, userId]);
//   }
// }


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
  // A retroactive type change alters the session's aggregates — flag for
  // re-sync of the trainer-facing summary AND queue the full-fidelity backup.
  if (row && userId) {
    await db.runAsync('UPDATE workout_sessions SET synced = 0 WHERE id = ? AND user_id = ?', [row.session_id, userId]);
    await enqueueUpsert('session', String(row.session_id));
    await enqueueUnsyncedPRs();
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
    `SELECT e.name AS exercise_name, e.muscle_group, se.position AS order_index,
            se.original_exercise_name
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
    ex.original_exercise_name = ex.original_exercise_name || null;
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
