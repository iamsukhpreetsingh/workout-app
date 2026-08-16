import { Share } from 'react-native';

// Plain-text, human-readable routine summaries handed to the OS share sheet.
// Privacy rule: only exercise names and sets/reps/weight structure are ever
// included — never notes, RPE, body metrics, photos, or timestamps.

function formatSetList(sets, { includeWeight = true } = {}) {
  return sets
    .map((s) => {
      const weight = includeWeight && s.weight ? ` @ ${s.weight}` : '';
      return `${s.reps}x${s.reps}${weight}`;
    })
    .join(', ');
}

// plan: { name, exercises: [{ name, target_sets, ... }] }
export function formatRoutineText(plan) {
  const lines = [plan.name, ''];
  plan.exercises.forEach((ex, i) => {
    lines.push(`${i + 1}. ${ex.name} — ${ex.target_sets} sets`);
  });
  lines.push('', 'Shared from Workout Tracker');
  return lines.join('\n');
}

// session: { name, exercises: [{ name, sets: [{ weight, reps, ... }] }] }
// Performed sets/reps/weight are included as the suggested starting point;
// RPE, notes, and timestamps are deliberately excluded.
export function formatSessionAsRoutineText(session) {
  const lines = [session.name, ''];
  session.exercises.forEach((ex, i) => {
    const perf = ex.sets
      .filter((s) => s.set_type !== 'warmup')
      .map((s) => (s.weight ? `${s.weight}x${s.reps}` : `${s.reps} reps`))
      .join(', ');
    lines.push(`${i + 1}. ${ex.name} — ${perf || 'unlogged'}`);
  });
  lines.push('', 'Shared from Workout Tracker');
  return lines.join('\n');
}

async function shareText(message) {
  try {
    await Share.share({ message, title: 'Workout Routine' });
  } catch (e) {
    // user dismissed the sheet or no share target available — not an error
  }
}

export function shareRoutine(plan) {
  return shareText(formatRoutineText(plan));
}

export function shareSessionAsRoutine(session) {
  return shareText(formatSessionAsRoutineText(session));
}
