// One-time v1 backfill (decision D3): every pre-upgrade local entity that
// was never backed up gets enqueued so the engine uploads it — automatic
// and silent on the first authenticated launch after upgrade. Idempotent
// and resumable by construction: enqueue is dedup-in-place, so an
// interrupted backfill is just a pending backlog. The per-user stamp only
// lands after the full sweep (multi-account devices each get their own
// backfill).
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { enqueueUpsert } from './syncEngine';
import { adoptLegacyMetrics } from '../db/body';

async function backfillDoneFor(userId) {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT backfill_v1_done AS v FROM user_settings WHERE id = 1');
  if (!row?.v || row.v === 0) return false;
  if (row.v === 1) return true;
  try { return !!((JSON.parse(row.v) || {})[userId]); } catch { return true; }
}

async function stampBackfillFor(userId) {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT backfill_v1_done AS v FROM user_settings WHERE id = 1');
  let map = {};
  try { map = JSON.parse(row?.v) || {}; } catch {}
  map[userId] = new Date().toISOString();
  await db.runAsync('UPDATE user_settings SET backfill_v1_done = ? WHERE id = 1', [JSON.stringify(map)]);
}


// One-time claim: pre-upgrade custom exercises have no owner; the first
// account to log in after the v26 upgrade takes them. Idempotent — no NULL
// customs remain after the first claim, so later logins no-op.
async function adoptLegacyCustomExercises(userId) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE exercises SET user_id = ? WHERE is_custom = 1 AND user_id IS NULL',
    [userId]
  );
}



export async function runBackfillIfNeeded() {
  const userId = getCurrentUserId();
  // if (!userId) return false;
  // if (await backfillDoneFor(userId)) return false;
  if (!userId) return false;
  await adoptLegacyCustomExercises(userId);
  if (await backfillDoneFor(userId)) return false;
  const db = await getDb();

  // claim pre-upgrade unscoped measurement rows + enqueue unsynced ones
  await adoptLegacyMetrics(userId);

  const sessions = await db.getAllAsync(
    'SELECT id FROM workout_sessions WHERE user_id = ? AND synced = 0', [userId]);
  for (const s of sessions) await enqueueUpsert('session', String(s.id));

  const plans = await db.getAllAsync(
    'SELECT id FROM workout_plans WHERE user_id = ? AND synced = 0', [userId]);
  for (const p of plans) await enqueueUpsert('workout_plan', String(p.id));

  // exercises/PRs/photos aren't user-scoped (single-owner-per-device design)
  // const customs = await db.getAllAsync(
  //   'SELECT id FROM exercises WHERE is_custom = 1 AND synced = 0');
    const customs = await db.getAllAsync(
    'SELECT id FROM exercises WHERE is_custom = 1 AND synced = 0 AND (user_id = ? OR user_id IS NULL)',
    [userId]);
  for (const e of customs) await enqueueUpsert('custom_exercise', String(e.id));

  const prs = await db.getAllAsync('SELECT id FROM personal_records WHERE synced = 0');
  for (const r of prs) await enqueueUpsert('personal_record', String(r.id));

  const photos = await db.getAllAsync('SELECT id FROM progress_photos WHERE synced = 0');
  for (const p of photos) await enqueueUpsert('progress_photo', String(p.id));

  await stampBackfillFor(userId);
  return true;
}