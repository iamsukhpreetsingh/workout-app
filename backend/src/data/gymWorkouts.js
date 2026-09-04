// gymWorkouts.js — gym-owned workout content (Phase 11).
//
// RULES:
//  - Gym-owned: separate from personal user workouts and trainer templates.
//  - Exercises are stored BY NAME with plain sets/reps/duration data —
//    deleting a catalog exercise can never break a gym workout.
//  - version increments on every CONTENT edit (title/description/exercises/
//    difficulty/goal/duration/tags). Publishing/archiving does not bump it.
//  - Saves are SNAPSHOTS: the member's copy is a full JSONB copy at their
//    saved version, independent of later gym edits until they explicitly
//    update. Duplicate saves are rejected (the update endpoint exists).
//  - Assignments reference gym_members (app_user_id NULL fully valid) and
//    survive until ended; duplicate non-expired ACTIVE assignment per
//    (member, workout) is rejected. ARCHIVED/DRAFT workouts cannot be newly
//    assigned. SINCE PHASE 13 assignments live in the UNIFIED
//    gym_content_assignments table (src/data/gymContentAssignments.js) —
//    the per-domain functions below are thin delegates kept for the legacy
//    /workout-assignments routes.
const { query, transaction } = require('../db/pool');
const contentAssignments = require('./gymContentAssignments');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
const GOALS = ['strength', 'fat_loss', 'endurance', 'mobility', 'general'];
const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const ASSIGNABLE_STATUSES = ['PUBLISHED'];

function validateWorkout(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.title !== undefined) {
    const title = String(data.title || '').trim();
    if (!title || title.length > 140) throw new HttpError(400, 'title is required (max 140 characters)');
    out.title = title;
  }
  if (data.description !== undefined) out.description = data.description || null;
  if (!partial || data.difficulty !== undefined) {
    const d = data.difficulty ?? 'beginner';
    if (!DIFFICULTIES.includes(d)) throw new HttpError(400, `difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    out.difficulty = d;
  }
  if (!partial || data.goal !== undefined) {
    const g = data.goal ?? 'general';
    if (!GOALS.includes(g)) throw new HttpError(400, `goal must be one of ${GOALS.join(', ')}`);
    out.goal = g;
  }
  if (data.estimated_duration_minutes !== undefined) {
    const n = Number(data.estimated_duration_minutes);
    if (data.estimated_duration_minutes != null && (!Number.isInteger(n) || n < 1 || n > 600)) {
      throw new HttpError(400, 'estimated_duration_minutes must be between 1 and 600');
    }
    out.estimated_duration_minutes = data.estimated_duration_minutes == null ? null : n;
  }
  if (data.tags !== undefined) {
    if (data.tags != null && !Array.isArray(data.tags)) throw new HttpError(400, 'tags must be an array of strings');
    out.tags = (data.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  }
  if (data.recommended !== undefined) out.recommended = !!data.recommended;
  if (data.status !== undefined) {
    if (!STATUSES.includes(data.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    out.status = data.status;
  }
  if (data.exercises !== undefined) {
    if (!Array.isArray(data.exercises)) throw new HttpError(400, 'exercises must be an array');
    out.exercises = data.exercises.map((e, i) => {
      const name = String(e.exercise_name || e.name || '').trim();
      if (!name) throw new HttpError(400, `exercises[${i}]: exercise_name is required`);
      const sets = e.sets == null ? null : Number(e.sets);
      if (sets != null && (!Number.isInteger(sets) || sets < 1 || sets > 50)) {
        throw new HttpError(400, `exercises[${i}]: sets must be 1-50`);
      }
      const dur = e.duration_minutes == null ? null : Number(e.duration_minutes);
      if (dur != null && (!Number.isInteger(dur) || dur < 1 || dur > 300)) {
        throw new HttpError(400, `exercises[${i}]: duration_minutes must be 1-300`);
      }
      return {
        exercise_name: name.slice(0, 140),
        sets, reps: e.reps ? String(e.reps).slice(0, 40) : null,
        duration_minutes: dur, order_index: i,
        notes: e.notes ? String(e.notes).slice(0, 500) : null,
      };
    });
  }
  return out;
}

// full workout with its exercises (ordered)
async function loadWorkout(client, gymId, workoutId) {
  const { rows } = await client.query(
    'SELECT * FROM gym_workouts WHERE id = $1 AND gym_id = $2',
    [workoutId, gymId]
  );
  if (!rows.length) return null;
  const workout = rows[0];
  const { rows: exercises } = await client.query(
    'SELECT id, exercise_name, sets, reps, duration_minutes, order_index, notes FROM gym_workout_exercises WHERE workout_id = $1 ORDER BY order_index',
    [workoutId]
  );
  return { ...workout, exercises };
}

async function createWorkout(gymId, actor, ip, data, gymAudit) {
  const fields = validateWorkout(data, { partial: false });
  if (!fields.exercises || !fields.exercises.length) {
    throw new HttpError(400, 'At least one exercise is required');
  }
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO gym_workouts
         (gym_id, title, description, difficulty, goal, estimated_duration_minutes,
          tags, status, recommended, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [gymId, fields.title, fields.description ?? null, fields.difficulty, fields.goal,
       fields.estimated_duration_minutes ?? null, fields.tags || [],
       fields.status ?? 'DRAFT', fields.recommended ?? false, actor?.userId ?? actor ?? null]
    );
    const workout = rows[0];
    for (const e of fields.exercises) {
      await client.query(
        `INSERT INTO gym_workout_exercises
           (workout_id, exercise_name, sets, reps, duration_minutes, order_index, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workout.id, e.exercise_name, e.sets, e.reps, e.duration_minutes, e.order_index, e.notes]
      );
    }
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'workout.created', entity: 'gym_workout', entityId: workout.id,
      after: { title: workout.title, status: workout.status, exercises: fields.exercises.length },
    });
    return loadWorkout(client, gymId, workout.id);
  });
}

const CONTENT_FIELDS = ['title', 'description', 'difficulty', 'goal',
  'estimated_duration_minutes', 'tags', 'exercises'];

async function updateWorkout(gymId, workoutId, actor, ip, patch, gymAudit) {
  const fields = validateWorkout(patch, { partial: true });
  const contentChanged = CONTENT_FIELDS.some((k) => fields[k] !== undefined);
  return transaction(async (client) => {
    const before = await loadWorkout(client, gymId, workoutId);
    if (!before) throw new HttpError(404, 'Workout not found');
    const sets = [];
    const vals = [workoutId, gymId];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'exercises') continue;
      vals.push(v === undefined ? null : v);
      sets.push(`${k} = $${vals.length}`);
    }
    // content edits open a new version; lifecycle changes (publish/archive) do not
    if (contentChanged) {
      vals.push(before.version + 1);
      sets.push(`version = $${vals.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'No valid fields to update');
    await client.query(
      `UPDATE gym_workouts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND gym_id = $2`,
      vals
    );
    if (fields.exercises) {
      await client.query('DELETE FROM gym_workout_exercises WHERE workout_id = $1', [workoutId]);
      for (const e of fields.exercises) {
        await client.query(
          `INSERT INTO gym_workout_exercises
             (workout_id, exercise_name, sets, reps, duration_minutes, order_index, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [workoutId, e.exercise_name, e.sets, e.reps, e.duration_minutes, e.order_index, e.notes]
        );
      }
    }
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'workout.updated', entity: 'gym_workout', entityId: workoutId,
      before: { status: before.status, version: before.version },
      after: { status: fields.status ?? before.status,
               version: contentChanged ? before.version + 1 : before.version },
    });
    return loadWorkout(client, gymId, workoutId);
  });
}

async function listWorkouts(gymId, { status, q, recommended } = {}) {
  const vals = [gymId];
  const where = ['w.gym_id = $1'];
  if (status) { vals.push(status); where.push(`w.status = $${vals.length}`); }
  if (recommended != null && recommended !== '') { vals.push(recommended === 'true'); where.push(`w.recommended = $${vals.length}`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(w.title ILIKE $${vals.length} OR w.description ILIKE $${vals.length})`);
  }
  const { rows } = await query(
    `SELECT w.*,
            (SELECT COUNT(*)::int FROM gym_workout_exercises e WHERE e.workout_id = w.id) AS exercise_count,
            (SELECT COUNT(*)::int FROM gym_content_assignments a
              WHERE a.workout_id = w.id AND a.status = 'ACTIVE'
                AND a.starts_on <= (SELECT (now() AT TIME ZONE g.timezone)::date FROM gyms g WHERE g.id = w.gym_id)
                AND (a.ends_on IS NULL OR a.ends_on >= (SELECT (now() AT TIME ZONE g.timezone)::date FROM gyms g WHERE g.id = w.gym_id))
            ) AS assigned_count,
            (SELECT COUNT(*)::int FROM gym_workout_saves s WHERE s.workout_id = w.id) AS saves_count
     FROM gym_workouts w WHERE ${where.join(' AND ')}
     ORDER BY (w.status = 'PUBLISHED') DESC, w.updated_at DESC`,
    vals
  );
  return rows;
}

async function getWorkout(gymId, workoutId) {
  return transaction(async (client) => loadWorkout(client, gymId, workoutId));
}

// ── direct assignment (Phase 13: delegated to the UNIFIED system) ────────
// Every row lives in gym_content_assignments; these wrappers preserve the
// Phase 11 route signatures and response shapes. `gymContext` enables
// trainer roster scoping inside the unified module.

async function assignWorkout(gymId, memberId, actor, ip, payload = {}, gymAudit, gymContext) {
  return contentAssignments.assignContent(
    gymId, memberId, actor, ip,
    { ...payload, content_type: 'WORKOUT' }, gymAudit, gymContext
  );
}

async function endWorkoutAssignment(gymId, assignmentId, actor, ip, { reason } = {}, gymAudit, gymContext) {
  return contentAssignments.endAssignment(gymId, assignmentId, actor, ip, { reason }, gymAudit, gymContext);
}

async function listMemberWorkoutAssignments(gymId, memberId, gymContext) {
  return contentAssignments.listMemberAssignments(gymId, memberId, { content_type: 'WORKOUT', ctx: gymContext });
}

async function listGymWorkoutAssignments(gymId, { workout_id } = {}, gymContext) {
  return contentAssignments.listAssignments(gymId, gymContext, { content_type: 'WORKOUT', content_id: workout_id });
}

// ── member saves (personal library snapshots) ────────────────────────────

function buildSnapshot(workout) {
  return {
    title: workout.title,
    description: workout.description,
    difficulty: workout.difficulty,
    goal: workout.goal,
    estimated_duration_minutes: workout.estimated_duration_minutes,
    tags: workout.tags,
    exercises: (workout.exercises || []).map((e) => ({
      exercise_name: e.exercise_name, sets: e.sets, reps: e.reps,
      duration_minutes: e.duration_minutes, order_index: e.order_index, notes: e.notes,
    })),
  };
}

// Save to personal library: a full SNAPSHOT at the current version — the
// member's copy never changes when the gym edits the original later.
async function saveWorkoutForMember(gymId, memberId, workoutId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT id FROM gym_members WHERE id = $1 AND gym_id = $2',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const workout = await loadWorkout(client, gymId, workoutId);
    if (!workout) throw new HttpError(404, 'Workout not found');
    if (workout.status === 'DRAFT') throw new HttpError(400, 'This workout is not published');
    const { rows: dupes } = await client.query(
      `SELECT id FROM gym_workout_saves WHERE workout_id = $1 AND member_id = $2`,
      [workoutId, memberId]
    );
    if (dupes.length) {
      throw new HttpError(409, 'This workout is already in your library — use "update" to pull the latest version');
    }
    const { rows } = await client.query(
      `INSERT INTO gym_workout_saves (gym_id, workout_id, member_id, saved_version, snapshot)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [gymId, workoutId, memberId, workout.version, JSON.stringify(buildSnapshot(workout))]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'workout.saved', entity: 'gym_workout_save', entityId: rows[0].id,
      after: { workout: workout.title, saved_version: workout.version },
    });
    return rows[0];
  });
}

// Explicit update: re-snapshot the CURRENT published version. The member
// chooses this — their copy is never moved automatically.
async function updateSavedWorkout(gymId, memberId, saveId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows: saveRows } = await client.query(
      `SELECT * FROM gym_workout_saves WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [saveId, gymId, memberId]
    );
    if (!saveRows.length) throw new HttpError(404, 'Saved workout not found');
    const save = saveRows[0];
    const workout = await loadWorkout(client, gymId, save.workout_id);
    if (!workout || workout.status === 'ARCHIVED') {
      throw new HttpError(409, 'The gym original is no longer available — your saved copy is untouched');
    }
    const { rows } = await client.query(
      `UPDATE gym_workout_saves SET saved_version = $3, snapshot = $4, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [save.id, gymId, workout.version, JSON.stringify(buildSnapshot(workout))]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'workout.save_updated', entity: 'gym_workout_save', entityId: save.id,
      before: { saved_version: save.saved_version },
      after: { saved_version: workout.version },
    });
    return rows[0];
  });
}

async function deleteSavedWorkout(gymId, memberId, saveId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `DELETE FROM gym_workout_saves WHERE id = $1 AND gym_id = $2 AND member_id = $3 RETURNING id`,
      [saveId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Saved workout not found');
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'workout.save_removed', entity: 'gym_workout_save', entityId: saveId,
    });
    return { ok: true };
  });
}

// ── member-facing aggregation (mobile / my endpoints) ────────────────────

// Everything the connected member can see across their ACTIVE gym
// memberships: recommended (published + flagged) and directly assigned.
// A member who left (no ACTIVE membership) gets nothing; reactivating
// brings the assignments back — they were never deleted.
async function listForMember(userId) {
  // base: the user's ACTIVE memberships in ACTIVE gyms (a member who left
  // sees nothing; reactivating restores everything — nothing was deleted).
  // RECOMMENDED content additionally requires an ACTIVE membership term;
  // DIRECTLY ASSIGNED workouts show regardless (the gym chose them).
  const memberships = await query(
    `SELECT m.id AS member_id, m.gym_id, g.name AS gym_name, g.timezone,
            EXISTS (SELECT 1 FROM member_memberships t
                    WHERE t.member_id = m.id AND t.status = 'ACTIVE') AS has_active_term
     FROM gym_members m JOIN gyms g ON g.id = m.gym_id
     WHERE m.app_user_id = $1 AND m.status = 'ACTIVE' AND g.status = 'ACTIVE'`,
    [userId]
  );
  const out = [];
  for (const mem of memberships.rows) {
    const recommended = mem.has_active_term ? await query(
      `SELECT w.id, w.gym_id, w.title, w.description, w.difficulty, w.goal,
              w.estimated_duration_minutes, w.tags, w.version,
              (SELECT json_agg(json_build_object('exercise_name', e.exercise_name, 'sets', e.sets,
                                                 'reps', e.reps, 'duration_minutes', e.duration_minutes,
                                                 'order_index', e.order_index, 'notes', e.notes)
                                ORDER BY e.order_index)
               FROM gym_workout_exercises e WHERE e.workout_id = w.id) AS exercises
       FROM gym_workouts w WHERE w.gym_id = $1 AND w.status = 'PUBLISHED' AND w.recommended = true
       ORDER BY w.updated_at DESC`,
      [mem.gym_id]
    ) : { rows: [] };
    const assigned = await query(
      `SELECT a.id AS assignment_id, a.created_at AS assigned_at,
              a.starts_on::text AS starts_on, a.ends_on::text AS ends_on,
              a.notes, a.assigned_version, a.content_type,
              w.id, w.gym_id, w.title, w.description, w.difficulty, w.goal,
              w.estimated_duration_minutes, w.tags, w.version, w.status AS workout_status,
              (SELECT json_agg(json_build_object('exercise_name', e.exercise_name, 'sets', e.sets,
                                                 'reps', e.reps, 'duration_minutes', e.duration_minutes,
                                                 'order_index', e.order_index, 'notes', e.notes)
                                ORDER BY e.order_index)
               FROM gym_workout_exercises e WHERE e.workout_id = w.id) AS exercises
       FROM gym_content_assignments a
       JOIN gym_workouts w ON w.id = a.workout_id
       WHERE a.member_id = $1 AND a.content_type = 'WORKOUT' AND a.status = 'ACTIVE'
         AND a.starts_on <= (now() AT TIME ZONE $2)::date
         AND (a.ends_on IS NULL OR a.ends_on >= (now() AT TIME ZONE $2)::date)
         AND w.status = 'PUBLISHED'
       ORDER BY a.created_at DESC`,
      [mem.member_id, mem.timezone]
    );
    const saves = await query(
      `SELECT s.id AS save_id, s.saved_version, s.snapshot, s.saved_at,
              w.id AS workout_id, w.version AS current_version, w.status AS workout_status
       FROM gym_workout_saves s JOIN gym_workouts w ON w.id = s.workout_id
       WHERE s.member_id = $1
       ORDER BY s.saved_at DESC`,
      [mem.member_id]
    );
    out.push({
      gym_id: mem.gym_id, gym_name: mem.gym_name,
      recommended: recommended.rows,
      assigned: assigned.rows,
      saved: saves.rows.map((r) => ({
        ...r,
        update_available: r.workout_status === 'PUBLISHED' && r.current_version > r.saved_version,
      })),
    });
  }
  return out;
}

module.exports = {
  DIFFICULTIES, GOALS, STATUSES,
  createWorkout, updateWorkout, listWorkouts, getWorkout,
  assignWorkout, endWorkoutAssignment, listMemberWorkoutAssignments, listGymWorkoutAssignments,
  saveWorkoutForMember, updateSavedWorkout, deleteSavedWorkout, listForMember,
};
