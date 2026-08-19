import { getDb } from '../db/db';
import { getSettings } from '../db/settings';
import { toLocalDateKey, computeStreaks } from './streakCalc';
import { getCurrentUserId } from '../db/userId';

async function loadDailyVolume(sinceMs = 0) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return {};
  const rows = await db.getAllAsync(
    `SELECT sess.start_time AS ts, COALESCE(SUM(s.weight * s.reps), 0) AS volume
     FROM workout_sessions sess
     LEFT JOIN session_exercises se ON se.session_id = sess.id
     LEFT JOIN sets s ON s.session_exercise_id = se.id AND s.set_type != 'warmup' AND s.completed = 1
     WHERE sess.start_time >= ? AND sess.user_id = ?
     GROUP BY sess.id`,
    [sinceMs, userId]
  );
  const byDay = {};
  for (const r of rows) {
    const key = toLocalDateKey(r.ts);
    byDay[key] = (byDay[key] || 0) + (r.volume || 0);
  }
  return byDay;
}

export async function calculateStreak(tolerance = null) {
  let tol = tolerance;
  if (tol == null) {
    const s = await getSettings();
    tol = s.streak_tolerance ?? 1;
  }
  const byDay = await loadDailyVolume();
  const dates = Object.keys(byDay);
  return computeStreaks(dates, toLocalDateKey(Date.now()), tol);
}

export async function getCalendarData(months = 6) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const byDay = await loadDailyVolume(startDate.getTime());
  // keep binary-or-volume map: value = that day's volume (0 stays absent)
  return byDay;
}
