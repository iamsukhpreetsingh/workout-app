// System 7 support helpers: 14-day periodic Local Only reminder state and
// the unsynced-data check for the logout warning.
import { getDb } from '../db/db';

const FOURTEEN_DAYS = 14 * 86400 * 1000;

export async function getLocalOnlyReminderState() {
  const db = await getDb();
  const row = await db.getFirstAsync(
    'SELECT last_local_only_reminder_shown_at AS v FROM user_settings WHERE id = 1');
  const last = row?.v ? Number(row.v) : null;
  return { due: !last || Date.now() - last >= FOURTEEN_DAYS, last };
}

export async function markLocalOnlyReminderShown() {
  const db = await getDb();
  await db.runAsync(
    'UPDATE user_settings SET last_local_only_reminder_shown_at = ? WHERE id = 1', [Date.now()]);
}

// True when there is genuinely unsynced local data that exists nowhere
// else — only then does the logout warning (System 7 #4) appear.
export async function hasUnsyncedBackupData() {
  const db = await getDb();
  const checks = [
    `SELECT 1 FROM sync_queue WHERE status IN ('PENDING','SYNCING','FAILED') LIMIT 1`,
    `SELECT 1 FROM workout_sessions WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM workout_plans WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM exercises WHERE is_custom = 1 AND synced = 0 LIMIT 1`,
    `SELECT 1 FROM body_metrics WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM local_recipes WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM local_diet_plans WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM local_supplement_plans WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM personal_records WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM progress_photos WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM local_diet_checkins WHERE synced = 0 LIMIT 1`,
    `SELECT 1 FROM local_supplement_checkins WHERE synced = 0 LIMIT 1`,
  ];
  for (const sql of checks) {
    try {
      const row = await db.getFirstAsync(sql);
      if (row) return true;
    } catch {}
  }
  return false;
}