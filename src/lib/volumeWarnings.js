import { getDb } from '../db/db';
import { getSettings } from '../db/settings';
import { getCurrentUserId } from '../db/userId';

export async function getVolumeWarnings() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const settings = await getSettings();
  const thresholdHigh = settings.vol_warning_threshold_high || 30;
  const thresholdLow = settings.vol_warning_threshold_low || -30;

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const fourWeeksAgo = new Date(weekStart);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  const currentWeekVolume = await db.getAllAsync(`
    SELECT e.muscle_group, COALESCE(SUM(s.weight * s.reps), 0) as volume
    FROM workout_sessions sess
    JOIN session_exercises se ON se.session_id = sess.id
    JOIN sets s ON s.session_exercise_id = se.id
    JOIN exercises e ON se.exercise_id = e.id
    WHERE sess.start_time >= ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1
    GROUP BY e.muscle_group
  `, [weekStart.getTime(), userId]);

  const priorWeeksVolume = await db.getAllAsync(`
    SELECT e.muscle_group, COALESCE(SUM(s.weight * s.reps), 0) as volume, 
           strftime('%W', sess.start_time / 1000, 'unixepoch') as week
    FROM workout_sessions sess
    JOIN session_exercises se ON se.session_id = sess.id
    JOIN sets s ON s.session_exercise_id = se.id
    JOIN exercises e ON se.exercise_id = e.id
    WHERE sess.start_time >= ? AND sess.start_time < ? AND sess.user_id = ? AND s.set_type != 'warmup' AND s.completed = 1
    GROUP BY e.muscle_group, week
  `, [fourWeeksAgo.getTime(), weekStart.getTime(), userId]);

  const avgVolumeByGroup = {};
  const countByGroup = {};
  
  for (const row of priorWeeksVolume) {
    if (!avgVolumeByGroup[row.muscle_group]) {
      avgVolumeByGroup[row.muscle_group] = 0;
      countByGroup[row.muscle_group] = 0;
    }
    avgVolumeByGroup[row.muscle_group] += row.volume;
    countByGroup[row.muscle_group]++;
  }

  for (const group of Object.keys(avgVolumeByGroup)) {
    if (countByGroup[group] > 0) {
      avgVolumeByGroup[group] /= countByGroup[group];
    }
  }

  const warnings = [];
  for (const curr of currentWeekVolume) {
    const avg = avgVolumeByGroup[curr.muscle_group] || 0;
    const weeks = countByGroup[curr.muscle_group] || 0;
    
    if (weeks < 3 || avg === 0) continue;

    const pctChange = ((curr.volume - avg) / avg) * 100;

    if (pctChange <= thresholdLow) {
      warnings.push({
        muscleGroup: curr.muscle_group,
        type: 'drop',
        pctChange: Math.round(pctChange),
        currentVolume: Math.round(curr.volume),
        avgVolume: Math.round(avg),
      });
    } else if (pctChange >= thresholdHigh) {
      warnings.push({
        muscleGroup: curr.muscle_group,
        type: 'spike',
        pctChange: Math.round(pctChange),
        currentVolume: Math.round(curr.volume),
        avgVolume: Math.round(avg),
      });
    }
  }

  return warnings;
}