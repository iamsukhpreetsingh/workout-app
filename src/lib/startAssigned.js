// Shared "start a trainer-assigned plan" flow — used by the assigned-plan
// detail screen and Home's pinned strip. Resolves each plain-text exercise
// name to a local SQLite exercise (creating a custom one if missing) and
// feeds the standard live-session machinery. The gym-workout starter
// (Mobile M2) rides the exact same machinery: gym content names exercises
// as plain text too, so the resolution is shared.
import { listExercises, createExercise, getLastSessionSetsByPosition } from '../db/queries';
import { getSettings } from '../db/settings';
import { ACTIVE_WORKOUT } from '../shared/constants/routes';

function guessMuscleGroup(name) {
  const n = name.toLowerCase();
  if (/(press|bench|fly|push|chest)/.test(n)) return 'Chest';
  if (/(row|pull|deadlift|lat)/.test(n)) return 'Back';
  if (/(squat|leg|calf|lunge|hip)/.test(n)) return 'Legs';
  if (/(shoulder|lateral|raise|delt)/.test(n)) return 'Shoulders';
  if (/(curl|extension|triceps|biceps)/.test(n)) return 'Arms';
  if (/(crunch|plank|core|abs)/.test(n)) return 'Core';
  return 'Core';
}

// Resolve an exercise NAME to the local library row, creating a custom
// exercise when missing. Shared by the assigned-plan starter and the
// live-session swap flow.
export async function resolveExerciseByName(name) {
  const localExercises = await listExercises();
  const match = localExercises.find(
    (e) => e.name.toLowerCase() === String(name).trim().toLowerCase()
  );
  if (match) return match;
  const guessGroup = guessMuscleGroup(name);
  const newId = await createExercise(name, guessGroup);
  return { id: newId, name, muscle_group: guessGroup };
}

export async function startAssignedPlan(plan, { dispatch, navigation }) {
  const localExercises = await listExercises();
  const byName = new Map(localExercises.map((e) => [e.name.toLowerCase(), e]));
  const settings = await getSettings();

  const planExercises = [];
  for (const ex of plan.exercises || []) {
    let local = byName.get(ex.exercise_name.toLowerCase());
    if (!local) {
      const guessGroup = guessMuscleGroup(ex.exercise_name);
      const newId = await createExercise(ex.exercise_name, guessGroup);
      local = { id: newId, name: ex.exercise_name, muscle_group: guessGroup };
    }
    planExercises.push({
      exercise_id: local.id,
      name: ex.exercise_name,
      muscle_group: local.muscle_group,
      target_sets: ex.target_sets,
      rest_seconds: ex.rest_seconds || settings.default_rest_seconds,
      group_id: ex.group_id || null,
      // configured alternatives for the live-swap picker
      alternatives: (ex.alternatives || []).map((a) =>
        typeof a === 'string' ? a : a.alternative_exercise_name ?? a.name
      ),
      // positional prior-session sets for per-set prefill
      prevSets: await getLastSessionSetsByPosition(local.id),
    });
  }

  dispatch({
    type: 'START_WORKOUT',
    name: plan.name,
    planExercises,
    defaultRest: settings.default_rest_seconds,
    sourceAssignedPlanId: plan.id, // marks the session trainer-assigned
  });
  navigation.navigate(ACTIVE_WORKOUT);
}

// ── Gym-recommended workouts (Mobile M2) ────────────────────────────────
// gym_workout_exercises rows are plain-text names + { sets, reps(TEXT like
// "8-12"/"AMRAP"), duration_minutes, notes } — a DIFFERENT data model from
// local plans (no exercise_id, no numeric reps target, and the live-session
// engine has never had a reps/duration target — personal plans don't
// either). So: resolve names through the SAME name→exercise bridge, map
// sets → target_sets, and keep reps/duration/notes as guidance text on the
// detail screen and in the saved routine's notes.

// Resolve + (if needed) create local exercises for a gym workout's
// exercise list. Returns [{ local, raw }] in workout order. Shared by the
// direct starter and the add-to-routines converter so both behave
// identically.
export async function resolveGymWorkoutExercises(workout) {
  const localExercises = await listExercises();
  const byName = new Map(localExercises.map((e) => [e.name.toLowerCase(), e]));
  const out = [];
  for (const ex of workout?.exercises || []) {
    const name = String(ex?.exercise_name || '').trim();
    if (!name) continue; // skip blank rows — never block the whole workout
    let local = byName.get(name.toLowerCase());
    if (!local) {
      const guessGroup = guessMuscleGroup(name);
      local = { id: await createExercise(name, guessGroup), name, muscle_group: guessGroup };
      byName.set(name.toLowerCase(), local);
    }
    out.push({ local, raw: ex });
  }
  return out;
}

// Start a gym workout directly with the standard live-session machinery.
export async function startGymWorkout(workout, { dispatch, navigation }) {
  const resolved = await resolveGymWorkoutExercises(workout);
  if (!resolved.length) throw new Error('This workout has no exercises yet.');
  const settings = await getSettings();
  const planExercises = [];
  for (const { local, raw } of resolved) {
    planExercises.push({
      exercise_id: local.id,
      name: local.name,
      muscle_group: local.muscle_group,
      target_sets: Number(raw.sets) || 3,
      rest_seconds: settings.default_rest_seconds,
      group_id: null,
      alternatives: [],
      prevSets: await getLastSessionSetsByPosition(local.id),
    });
  }
  // sourceAssignedPlanId stays null: gym workouts are not trainer
  // assignments — the session is simply named after the gym workout.
  dispatch({
    type: 'START_WORKOUT',
    name: workout.title || 'Gym Workout',
    planExercises,
    defaultRest: settings.default_rest_seconds,
  });
  navigation.navigate(ACTIVE_WORKOUT);
}

// Convert a gym workout into (plan args for createPlan) — the user's
// personal routines. Per-exercise reps/duration/notes guidance is preserved
// as text in the plan notes (plan_exercises has no reps column — same as
// every personal plan).
export async function gymWorkoutToPlanArgs(workout) {
  const resolved = await resolveGymWorkoutExercises(workout);
  if (!resolved.length) throw new Error('This workout has no exercises to add.');
  const lines = resolved.map(({ local, raw }) => {
    const bits = [];
    if (raw.sets) bits.push(`${raw.sets} set${raw.sets > 1 ? 's' : ''}`);
    if (raw.reps) bits.push(`${raw.reps} reps`);
    if (raw.duration_minutes) bits.push(`${raw.duration_minutes} min`);
    if (raw.notes) bits.push(raw.notes);
    return bits.length ? `- ${local.name}: ${bits.join(' · ')}` : `- ${local.name}`;
  });
  const guidance = workout.description ? [workout.description, '', 'Exercises:'] : ['Exercises:'];
  const notes = [...guidance, ...lines].join('\n');
  return {
    name: workout.title || 'Gym Workout',
    notes,
    exercises: resolved.map(({ local, raw }) => ({
      exerciseId: local.id,
      targetSets: Number(raw.sets) || 3,
      restSeconds: null, // createPlan default
      groupId: null,
    })),
  };
}
