import React, { createContext, useContext, useEffect, useReducer } from 'react';
import { getDb } from '../db/db';
import { positionalPrevs } from './prefillSets';

// Active workout. Shape:
// {
//   startTime, pausedAt (ms|null), pausedMs (accumulated), name, planId, notes,
//   exercises: [{ key, exerciseId, name, muscleGroup, restSeconds, groupId, notes,
//                 sets: [{ key, weight, reps, type, rpe, completed, prev }] }],
//   groups: { [groupId]: { restAfterRound: true } },
//   restTimer: { id, endsAt, total, label } | null
// }
// `prev` on a set = last session's same-position performance. It is shown as
// PLACEHOLDER text only — never as real, submittable values (item 5).
// The whole state is persisted to the active_workout table after every
// change so the mini-bar and timer survive app kills.

const WorkoutContext = createContext(null);

let keyCounter = 0;
const nextKey = () => `k${++keyCounter}`;
let groupCounter = 0;
const nextGroupId = () => `g${Date.now()}_${++groupCounter}`;

const initialState = null;

const emptySet = () => ({
  key: nextKey(),
  weight: '',
  reps: '',
  type: 'working',
  rpe: null,
  completed: false,
  prev: null,
});

function completedCount(ex) {
  return ex.sets.filter((s) => s.completed).length;
}

function shouldStartRest(state, ex) {
  if (!ex.groupId) return true;
  const groupRest = state.groups?.[ex.groupId]?.restAfterRound ?? true;
  if (!groupRest) return true;
  const siblings = state.exercises.filter((e) => e.groupId === ex.groupId);
  const round = completedCount(ex);
  return siblings.every((s) => completedCount(s) >= round);
}

function reducer(state, action) {
  switch (action.type) {
    case 'START_WORKOUT': {
      const { name, planId, planExercises, defaultRest, sourceAssignedPlanId } = action;
      return {
        startTime: Date.now(),
        pausedAt: null,
        pausedMs: 0,
        name: name || 'Workout',
        planId: planId || null,
        sourceAssignedPlanId: sourceAssignedPlanId || null,
        notes: '',
        groups: {},
        restTimer: null,
        exercises: (planExercises || []).map((ex) => {
          // POSITIONAL prefill first (set N ← prior session's set N); the
          // best weight/reps pair is only a fallback when the exercise has
          // NO logged history at all.
          const prevs = positionalPrevs(ex.prevSets);
          const bestWeight = ex.bestWeight || 0;
          const bestReps = ex.bestReps || 0;
          const hasPrev = prevs.length > 0 || bestWeight > 0 || bestReps > 0;
          const count = prevs.length || (ex.target_sets || 3);
          const sets = [];
          for (let i = 0; i < count; i++) {
            const s = emptySet();
            if (prevs[i]) s.prev = prevs[i];
            else if (!prevs.length && hasPrev) s.prev = { weight: bestWeight, reps: bestReps, rpe: null };
            sets.push(s);
          }
          return {
            key: nextKey(),
            exerciseId: ex.exercise_id ?? ex.exerciseId,
            name: ex.name,
            muscleGroup: ex.muscle_group ?? ex.muscleGroup,
            restSeconds: ex.rest_seconds ?? ex.restSeconds ?? defaultRest ?? 90,
            groupId: ex.group_id ?? ex.groupId ?? null,
            notes: '',
            // configured alternatives for the live-swap picker (0-3)
            alternatives: (ex.alternatives || []).map((a) =>
              typeof a === 'string' ? a : a.name
            ),
            // populated only when a mid-session swap occurred
            originalExerciseName: null,
            sets,
          };
        }),
      };
    }
    case 'RESTORE_WORKOUT':
      return action.workout;
    case 'ADD_EXERCISE': {
      const { exercise, previousSets, defaultRest, bestWeight, bestReps } = action;
      // POSITIONAL prefill: set N's placeholder = prior session's set N
      // (its actual weight AND its actual reps). Positions with no prior
      // data get no hint at all — never the last known set repeated.
      const prevs = positionalPrevs(previousSets);
      const mk = (prev) => ({ ...emptySet(), prev });
      let sets;
      if (prevs.length) {
        sets = prevs.map((p) => mk(p));
      } else if (bestWeight > 0 || bestReps > 0) {
        sets = [1, 2, 3].map(() => mk({ weight: bestWeight, reps: bestReps, rpe: null }));
      } else {
        sets = [1, 2, 3].map(() => emptySet());
      }
      return {
        ...state,
        exercises: [
          ...state.exercises,
          {
            key: nextKey(),
            exerciseId: exercise.id,
            name: exercise.name,
            muscleGroup: exercise.muscle_group,
            restSeconds: defaultRest ?? 90,
            groupId: null,
            notes: '',
            sets,
          },
        ],
      };
    }
    // Mid-session swap. Session-local ONLY — the source routine/template/
    // assigned plan is never touched.
    //  - No logged sets yet: rename this entry in place (position, superset
    //    group_id, rest seconds, notes and target sets all carry over).
    //  - Sets already logged: SPLIT — logged sets stay attributed to the
    //    original exercise; a new session_exercises entry for the swap
    //    target takes over the remaining (unlogged) sets, inserted at the
    //    same position so order/superset structure is preserved.
    case 'SWAP_EXERCISE': {
      const { exerciseKey, exercise } = action;
      const hasValues = (s) =>
        s.completed || parseFloat(s.weight) > 0 || parseInt(s.reps, 10) > 0;
      return {
        ...state,
        exercises: state.exercises.flatMap((e) => {
          if (e.key !== exerciseKey) return [e];
          const originalName = e.originalExerciseName || e.name;
          const logged = e.sets.filter(hasValues);
          if (logged.length === 0) {
            return [
              {
                ...e,
                name: exercise.name,
                exerciseId: exercise.id,
                muscleGroup: exercise.muscle_group ?? exercise.muscleGroup ?? null,
                originalExerciseName: originalName,
              },
            ];
          }
          const remaining = e.sets.filter((s) => !hasValues(s));
          const swappedEntry = {
            key: nextKey(),
            exerciseId: exercise.id,
            name: exercise.name,
            muscleGroup: exercise.muscle_group ?? exercise.muscleGroup ?? null,
            restSeconds: e.restSeconds,
            groupId: e.groupId,
            notes: e.notes,
            alternatives: [],
            originalExerciseName: originalName,
            sets: remaining.length ? remaining : [emptySet()],
          };
          return [{ ...e, sets: logged }, swappedEntry];
        }),
      };
    }
    case 'REMOVE_EXERCISE': {
      const removed = state.exercises.find((e) => e.key === action.key);
      let exercises = state.exercises.filter((e) => e.key !== action.key);
      if (removed?.groupId) {
        const remainingInGroup = exercises.filter((e) => e.groupId === removed.groupId);
        if (remainingInGroup.length === 1) {
          exercises = exercises.map((e) =>
            e.groupId === removed.groupId ? { ...e, groupId: null } : e
          );
        }
      }
      return { ...state, exercises };
    }
    case 'ADD_SET':
      return {
        ...state,
        exercises: state.exercises.map((e) => {
          if (e.key !== action.exerciseKey) return e;
          const last = [...e.sets].reverse().find((s) => !s.completed) || e.sets[e.sets.length - 1];
          return { ...e, sets: [...e.sets, emptySet(last)] };
        }),
      };
    case 'DUPLICATE_SET': {
      const ex = state.exercises.find((e) => e.key === action.exerciseKey);
      if (!ex || ex.sets.length === 0) return state;
      const lastSet = ex.sets[ex.sets.length - 1];
      const newSet = {
        ...emptySet(),
        weight: lastSet.weight,
        reps: lastSet.reps,
        type: lastSet.type,
        prev: { weight: parseFloat(lastSet.weight) || 0, reps: parseInt(lastSet.reps, 10) || 0, rpe: null },
      };
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey ? { ...e, sets: [...e.sets, newSet] } : e
        ),
      };
    }
    case 'REMOVE_SET':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? { ...e, sets: e.sets.filter((s) => s.key !== action.setKey) }
            : e
        ),
      };
    case 'UPDATE_SET':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? {
                ...e,
                sets: e.sets.map((s) =>
                  s.key === action.setKey ? { ...s, [action.field]: action.value } : s
                ),
              }
            : e
        ),
      };
    // Quick-fill a set's empty fields from its previous-performance values
    // (one-tap "use last"). Only fills fields the user hasn't typed into.
    case 'FILL_FROM_PREV': {
      const ex = state.exercises.find((e) => e.key === action.exerciseKey);
      if (!ex) return state;
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? {
                ...e,
                sets: e.sets.map((s) => {
                  if (s.key !== action.setKey || !s.prev) return s;
                  return {
                    ...s,
                    weight: s.weight === '' ? String(s.prev.weight) : s.weight,
                    reps: s.reps === '' ? String(s.prev.reps) : s.reps,
                  };
                }),
              }
            : e
        ),
      };
    }
    case 'TOGGLE_SET_TYPE':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? {
                ...e,
                sets: e.sets.map((s) =>
                  s.key === action.setKey
                    ? { ...s, type: CYCLE[s.type] || 'working' }
                    : s
                ),
              }
            : e
        ),
      };
    case 'COMPLETE_SET': {
      const ex = state.exercises.find((e) => e.key === action.exerciseKey);
      if (!ex) return state;
      const setIndex = ex.sets.findIndex((s) => s.key === action.setKey);
      const completedSet = ex.sets[setIndex];
      if (!completedSet) return state;

      const next = {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? {
                ...e,
                sets: e.sets.map((s, idx) => {
                  if (s.key === action.setKey) return { ...s, completed: true };
                  if (idx > setIndex && !s.completed && !s.prev) {
                    const w = parseFloat(completedSet.weight) || 0;
                    const r = parseInt(completedSet.reps, 10) || 0;
                    if (w > 0 || r > 0) {
                      return { ...s, prev: { weight: w, reps: r, rpe: completedSet.rpe ?? null } };
                    }
                  }
                  return s;
                }),
              }
            : e
        ),
      };
      if (shouldStartRest(state, ex)) {
        const seconds = ex.restSeconds || 90;
        next.restTimer = {
          id: Date.now(),
          endsAt: Date.now() + seconds * 1000,
          total: seconds,
          label: ex.name,
        };
      }
      return next;
    }
    // Bidirectional: un-marking a done set removes it from volume/PRs again
    case 'UNCOMPLETE_SET':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey
            ? {
                ...e,
                sets: e.sets.map((s) =>
                  s.key === action.setKey ? { ...s, completed: false } : s
                ),
              }
            : e
        ),
      };
    case 'SET_REST_SECONDS':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey ? { ...e, restSeconds: action.seconds } : e
        ),
      };
    case 'SET_EXERCISE_NOTES':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey ? { ...e, notes: action.notes } : e
        ),
      };
    case 'LINK_SUPERSET': {
      const keys = new Set(action.exerciseKeys);
      const groupId = nextGroupId();
      const exercises = state.exercises.map((e) =>
        keys.has(e.key) ? { ...e, groupId } : e
      );
      return {
        ...state,
        exercises,
        groups: { ...(state.groups || {}), [groupId]: { restAfterRound: true } },
      };
    }
    case 'UNLINK_EXERCISE':
      return {
        ...state,
        exercises: state.exercises.map((e) =>
          e.key === action.exerciseKey ? { ...e, groupId: null } : e
        ),
      };
    case 'TOGGLE_GROUP_REST': {
      const gid = action.groupId;
      const current = state.groups?.[gid]?.restAfterRound ?? true;
      return {
        ...state,
        groups: { ...state.groups, [gid]: { restAfterRound: !current } },
      };
    }
    case 'PAUSE_WORKOUT':
      if (!state || state.pausedAt) return state;
      return { ...state, pausedAt: Date.now(), restTimer: null };
    case 'RESUME_WORKOUT': {
      if (!state || !state.pausedAt) return state;
      const pausedMs = (state.pausedMs || 0) + (Date.now() - state.pausedAt);
      return { ...state, pausedAt: null, pausedMs };
    }
    // Restart: wipe logged sets, reset timer, keep the same exercise list
    case 'RESTART_WORKOUT': {
      if (!state) return state;
      return {
        ...state,
        startTime: Date.now(),
        pausedAt: null,
        pausedMs: 0,
        notes: '',
        restTimer: null,
        exercises: state.exercises.map((e) => ({
          ...e,
          notes: '',
          sets: e.sets.map((s) => ({
            ...s,
            weight: '',
            reps: '',
            type: 'working',
            rpe: null,
            completed: false,
          })),
        })),
      };
    }
    case 'START_REST': {
      const endsAt = Math.max(action.endsAt || 0, Date.now() + 1000);
      return {
        ...state,
        restTimer: {
          id: action.id || Date.now(),
          endsAt,
          total: action.total || Math.round((endsAt - Date.now()) / 1000),
          label: action.label || '',
        },
      };
    }
    case 'ADJUST_REST': {
      if (!state.restTimer) return state;
      const delta = action.delta * 1000;
      const endsAt = Math.max(state.restTimer.endsAt + delta, Date.now() + 1000);
      return {
        ...state,
        restTimer: {
          ...state.restTimer,
          endsAt,
          total: state.restTimer.total + action.delta,
        },
      };
    }
    case 'SKIP_REST':
      return { ...state, restTimer: null };
    case 'SET_NOTES':
      return { ...state, notes: action.notes };
    case 'SET_NAME':
      return { ...state, name: action.name };
    case 'CLEAR_WORKOUT':
      return null;
    default:
      return state;
  }
}

const CYCLE = { working: 'warmup', warmup: 'dropset', dropset: 'failure', failure: 'working' };

// ---- persistence ---------------------------------------------------------
async function persistWorkout(workout) {
  try {
    const db = await getDb();
    if (!workout) {
      await db.runAsync('DELETE FROM active_workout WHERE id = 1');
      return;
    }
    await db.runAsync(
      'INSERT INTO active_workout (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = ?, updated_at = ?',
      [JSON.stringify(workout), Date.now(), JSON.stringify(workout), Date.now()]
    );
  } catch {
    // persistence is best-effort; never block logging on it
  }
}

async function restoreWorkout() {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync('SELECT json FROM active_workout WHERE id = 1');
    if (!row) return null;
    const w = JSON.parse(row.json);
    if (!w || !w.startTime) return null;
    // drop stale timers/pauses that no longer make sense after a cold start
    if (w.restTimer && w.restTimer.endsAt <= Date.now()) w.restTimer = null;
    return w;
  } catch {
    return null;
  }
}

export function WorkoutProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Restore an in-progress workout after an app kill. Elapsed time is always
  // recomputed from startTime (+ pause accounting) — never an in-memory counter.
  useEffect(() => {
    restoreWorkout().then((w) => {
      if (w) dispatch({ type: 'RESTORE_WORKOUT', workout: w });
    });
  }, []);

  useEffect(() => {
    persistWorkout(state);
  }, [state]);

  return (
    <WorkoutContext.Provider value={{ workout: state, dispatch }}>
      {children}
    </WorkoutContext.Provider>
  );
}

export function useWorkout() {
  const ctx = useContext(WorkoutContext);
  if (!ctx) throw new Error('useWorkout must be used inside WorkoutProvider');
  return ctx;
}

// Elapsed active-logging seconds, excluding paused intervals
export function elapsedSeconds(workout, now = Date.now()) {
  if (!workout) return 0;
  const end = workout.pausedAt ?? now;
  return Math.max(0, Math.floor((end - workout.startTime - (workout.pausedMs || 0)) / 1000));
}

export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Assign labels A, B, C… to group ids by first appearance in the list
export function groupLabels(exercises) {
  const labels = {};
  let n = 0;
  for (const e of exercises) {
    if (e.groupId && !(e.groupId in labels)) {
      labels[e.groupId] = String.fromCharCode(65 + n++);
    }
  }
  return labels;
}
