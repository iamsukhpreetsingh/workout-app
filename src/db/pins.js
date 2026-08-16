import { getDb } from './db';

// Hard cap across BOTH routine sources combined — one constant, one place.
export const MAX_PINNED_ROUTINES = 6;

export async function listPins() {
  const db = await getDb();
  return db.getAllAsync(
    'SELECT * FROM pinned_routines ORDER BY order_index ASC, pinned_at ASC'
  );
}

// Set of `${source_type}:${routine_ref_id}` for cheap card-state lookups
export async function getPinnedSet() {
  const pins = await listPins();
  return new Set(pins.map((p) => `${p.source_type}:${p.routine_ref_id}`));
}

export async function getPinCount() {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM pinned_routines');
  return row.c;
}

// Returns true if pinned (added), false if unpinned (removed). Throws with
// .capHit = true when the attempt would exceed MAX_PINNED_ROUTINES — callers
// must surface the message, never fail silently.
export async function togglePin(sourceType, refId) {
  const db = await getDb();
  refId = String(refId);
  const existing = await db.getFirstAsync(
    'SELECT id FROM pinned_routines WHERE source_type = ? AND routine_ref_id = ?',
    [sourceType, refId]
  );
  if (existing) {
    await db.runAsync('DELETE FROM pinned_routines WHERE id = ?', [existing.id]);
    return false;
  }
  const count = await getPinCount();
  if (count >= MAX_PINNED_ROUTINES) {
    const err = new Error(`You can pin up to ${MAX_PINNED_ROUTINES} routines — unpin one first`);
    err.capHit = true;
    throw err;
  }
  const max = await db.getFirstAsync(
    'SELECT COALESCE(MAX(order_index), -1) AS m FROM pinned_routines'
  );
  await db.runAsync(
    'INSERT INTO pinned_routines (source_type, routine_ref_id, pinned_at, order_index) VALUES (?, ?, ?, ?)',
    [sourceType, refId, new Date().toISOString(), max.m + 1]
  );
  return true;
}

export async function removePin(sourceType, refId) {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM pinned_routines WHERE source_type = ? AND routine_ref_id = ?',
    [sourceType, String(refId)]
  );
}

// Silently drop pins whose source routine no longer exists / is no longer
// active. Called on Home load with the current valid id sets.
export async function removeStalePins(selfPlanIds = [], assignedPlanIds = []) {
  const db = await getDb();
  const pins = await listPins();
  const selfSet = new Set(selfPlanIds.map(String));
  const assignedSet = new Set(assignedPlanIds.map(String));
  for (const p of pins) {
    const valid =
      p.source_type === 'self'
        ? selfSet.has(p.routine_ref_id)
        : p.source_type === 'trainer_assigned'
        ? assignedSet.has(p.routine_ref_id)
        : false;
    if (!valid) {
      await db.runAsync('DELETE FROM pinned_routines WHERE id = ?', [p.id]);
    }
  }
}
