// Shared "start a trainer-assigned plan" flow — used by the assigned-plan
// detail screen and Home's pinned strip. Resolves each plain-text exercise
// name to a local SQLite exercise (creating a custom one if missing) and
// feeds the standard live-session machinery.
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
