// Progression engine bridge (System 3 foundation): fetch + cache the
// RESOLVED formula setting (works offline — a gym has poor signal), build
// the recent-history payload from local SQLite in the exact contract the
// formula files document, and expose one call the logging screen will use:
// getSuggestionForExercise(exerciseId).
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { api } from './api';
import { getFormula, DEFAULT_FORMULA_KEY } from '../progressionFormulas';

// Fetch the resolved setting and cache it in user_settings. Called on
// login/foreground; failures are silent (cached values stand).
export async function fetchAndCacheProgressionSetting() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  try {
    const resolved = await api('/client/progression-resolved');
    const db = await getDb();
    await db.runAsync(
      `UPDATE user_settings SET progression_formula_key = ?, progression_params = ?,
         progression_source = ?, progression_trainer_name = ?
       WHERE id = 1`,
      [resolved.formula_key, JSON.stringify(resolved.params || {}),
       resolved.source || 'default', resolved.trainer_name || null]
    );
    return resolved;
  } catch {
    return null;
  }
}

// Offline-safe read: cached values, schema defaults merged over missing
// params, app default when nothing was ever cached.
export async function getCachedProgressionSetting() {
  const db = await getDb();
  const row = await db.getFirstAsync(
    `SELECT progression_formula_key AS k, progression_params AS p,
            progression_source AS s, progression_trainer_name AS t
     FROM user_settings WHERE id = 1`);
  let params = {};
  try { params = JSON.parse(row?.p || '{}') || {}; } catch {}
  const key = row?.k || DEFAULT_FORMULA_KEY;
  const formula = getFormula(key) || getFormula(DEFAULT_FORMULA_KEY);
  const merged = {};
  for (const p of formula?.paramSchema || []) merged[p.key] = p.default;
  Object.assign(merged, params);
  return {
    formula_key: formula ? (getFormula(key) ? key : DEFAULT_FORMULA_KEY) : DEFAULT_FORMULA_KEY,
    params: merged,
    source: row?.s || 'default',
    trainer_name: row?.t || null,
  };
}




// Build the history contract: working sets (warm-ups excluded) from the
// last 3 sessions containing this exercise, most recent session first,
// stamped with sessionIndex / targetReps / trainingMax. Blank placeholder
// rows are skipped; a REAL missed set (numbers but not completed) is kept —
// it should block progression.
// WEIGHT-GROUPING NOTE: sets within one exercise entry may span multiple
// distinct working weights (ramp/pyramid structure) — always group by weight
// and evaluate the top group (see progressionFormulas/weightGroups.js);
// never assume all sets in an exercise share one target weight. targetReps
// is stamped per session from the TOP weight group's best set so formulas
// get a meaningful target even for ramped sessions.
export async function getRecentHistoryForExercise(exerciseId, maxSessions = 3) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const ex = await db.getFirstAsync('SELECT training_max FROM exercises WHERE id = ?', [exerciseId]);
  const trainingMax = ex?.training_max ?? null;
  const rows = await db.getAllAsync(
    `SELECT s.weight, s.reps, s.rpe, s.completed, s.position, s.set_type,
            sess.id AS session_id, sess.start_time
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN workout_sessions sess ON se.session_id = sess.id
     WHERE se.exercise_id = ? AND sess.user_id = ? AND s.set_type != 'warmup'
     ORDER BY sess.start_time DESC, se.position ASC, s.position ASC
     LIMIT 100`,
    [exerciseId, userId]
  );
  const bySession = new Map();
  for (const r of rows) {
    const real = r.completed !== 0 || (Number(r.weight) > 0 || Number(r.reps) > 0);
    if (!real) continue;
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  const history = [];
  [...bySession.entries()].slice(0, maxSessions).forEach(([sid, sets], sessionIndex) => {
    // targetReps comes from the TOP weight group of the session (the working
    // set being progressed), NOT the opening set — ramped sessions start light.
    const weights = sets.map((s) => Number(s.weight) || 0);
    const topWeight = Math.max(...weights);
    const targetReps = Math.max(
      0,
      ...sets.filter((s, i) => weights[i] === topWeight).map((s) => Number(s.reps) || 0)
    );
    for (const st of sets) {
      history.push({
        weight: Number(st.weight) || 0,
        reps: Number(st.reps) || 0,
        targetReps,
        completed: st.completed !== 0,
        rpe: st.rpe ?? null,
        setType: st.set_type || 'working',
        sessionIndex,
        trainingMax,
        performedAt: st.start_time,
      });
    }
  });
  return history;
}

// The one call the logging screen makes (Phase B). Returns
// { suggestion: {suggestedWeight, suggestedReps, rationale} | null,
//   missingTrainingMax: boolean } — never throws.
export async function getSuggestionForExercise(exerciseId) {
  try {
    const setting = await getCachedProgressionSetting();
    const formula = getFormula(setting.formula_key);
    if (!formula) return { suggestion: null, missingTrainingMax: false };
    const history = await getRecentHistoryForExercise(exerciseId);
    if (!history.length) return { suggestion: null, missingTrainingMax: false };
    if (formula.requiresTrainingMax && !(Number(history[0].trainingMax) > 0)) {
      return { suggestion: null, missingTrainingMax: true };
    }
    const suggestion = formula.calculate(history, setting.params);
    return { suggestion, missingTrainingMax: false };
  } catch (e) {
    console.warn('[PROGRESSION] suggestion failed:', e.message);
    return { suggestion: null, missingTrainingMax: false };
  }
}