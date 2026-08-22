// Local-first data access for SELF-AUTHORED supplement plans — same
// contract as dietPlans.js: local writes + queued backup upserts, offline
// check-ins, one-time pull of migrated server data.
import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { api } from '../lib/api';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const parse = (v) => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};
const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const newLocalId = () => `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const isLocalSupplementPlanId = (id) =>
  typeof id === 'string' && (id.startsWith('sp_') || id.startsWith('mig_'));

const loadedUsers = new Set();

export async function ensureSupplementPlansLoaded() {
  const userId = getCurrentUserId();
  if (!userId || loadedUsers.has(userId)) return;
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS c FROM local_supplement_plans WHERE user_id = ?', [userId]);
  if (row.c > 0) {
    loadedUsers.add(userId);
    return;
  }
  try {
    const [plans, checkins] = await Promise.all([
      api('/user/backup/supplement-plans'),
      api('/user/backup/supplement-checkins').catch(() => []),
    ]);
    for (const p of plans || []) {
      await db.runAsync(
        `INSERT OR IGNORE INTO local_supplement_plans
           (local_id, server_id, user_id, synced, name, notes, tags, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [p.local_entity_id, p.id, userId, 1, p.name, p.notes ?? null, arr(p.tags), Date.now(), Date.now()]
      );
      for (const it of p.items || []) {
        await db.runAsync(
          `INSERT OR IGNORE INTO local_supplement_plan_items
             (local_id, supplement_plan_local_id, supplement_name, dosage, timing, notes, order_index)
           VALUES (?,?,?,?,?,?,?)`,
          [it.local_entity_id, p.local_entity_id, it.supplement_name, it.dosage ?? null,
           it.timing ?? null, it.notes ?? null, it.order_index ?? 0]
        );
      }
    }
    for (const c of checkins || []) {
      await db.runAsync(
        `INSERT INTO local_supplement_checkins (user_id, supplement_plan_local_id, date, taken, note, synced)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(supplement_plan_local_id, date) DO UPDATE SET
           taken = excluded.taken, note = excluded.note, synced = 1`,
        [userId, c.supplement_plan_local_id, c.date, c.taken ? 1 : 0, c.note ?? null]
      );
    }
    loadedUsers.add(userId);
  } catch {
    // offline — retried next open
  }
}

function hydrate(p, items) {
  return {
    ...p,
    id: p.local_id,
    tags: parse(p.tags),
    trainer_name: null,
    created_at: p.created_at ? new Date(p.created_at).toISOString() : new Date().toISOString(),
    items: items.map((it) => ({ ...it, id: it.local_id })),
    item_count: items.length,
  };
}

export async function listLocalSupplementPlans() {
  await ensureSupplementPlansLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  const plans = await db.getAllAsync(
    'SELECT * FROM local_supplement_plans WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  const out = [];
  for (const p of plans) {
    const items = await db.getAllAsync(
      'SELECT * FROM local_supplement_plan_items WHERE supplement_plan_local_id = ? ORDER BY order_index',
      [p.local_id]);
    out.push(hydrate(p, items));
  }
  return out;
}

export async function getSupplementPlan(localId) {
  await ensureSupplementPlansLoaded();
  const db = await getDb();
  const userId = getCurrentUserId();
  const p = await db.getFirstAsync(
    'SELECT * FROM local_supplement_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  if (!p) return null;
  const items = await db.getAllAsync(
    'SELECT * FROM local_supplement_plan_items WHERE supplement_plan_local_id = ? ORDER BY order_index',
    [localId]);
  return hydrate(p, items);
}

// payload: { name, notes, tags, items: [{ supplement_name, dosage, timing, notes }] }
export async function createSupplementPlan(payload) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  const localId = newLocalId();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO local_supplement_plans (local_id, user_id, synced, name, notes, tags, created_at, updated_at)
     VALUES (?,?,0,?,?,?,?,?)`,
    [localId, userId, String((payload || {}).name || 'Supplement Plan').trim(),
     payload?.notes ?? null, arr(payload?.tags), now, now]
  );
  await writeItems(db, localId, payload?.items || []);
  await enqueueUpsert('supplement_plan', localId);
  return localId;
}

export async function updateSupplementPlan(localId, payload) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync('DELETE FROM local_supplement_plan_items WHERE supplement_plan_local_id = ?', [localId]);
  await writeItems(db, localId, payload?.items || []);
  await db.runAsync(
    `UPDATE local_supplement_plans SET name = ?, notes = ?, tags = ?, synced = 0, updated_at = ?
     WHERE local_id = ? AND user_id = ?`,
    [String((payload || {}).name || 'Supplement Plan').trim(), payload?.notes ?? null,
     arr(payload?.tags), Date.now(), localId, userId]);
  await enqueueUpsert('supplement_plan', localId);
}

async function writeItems(db, planLocalId, items) {
  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i] || {};
    await db.runAsync(
      `INSERT INTO local_supplement_plan_items
         (local_id, supplement_plan_local_id, supplement_name, dosage, timing, notes, order_index)
       VALUES (?,?,?,?,?,?,?)`,
      [`${planLocalId}:i${i}`, planLocalId, String(it.supplement_name || 'Supplement').trim(),
       it.dosage ?? null, it.timing ?? null, it.notes ?? null, i]
    );
  }
}

export async function deleteSupplementPlan(localId) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const row = await db.getFirstAsync(
    'SELECT server_id FROM local_supplement_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await db.runAsync('DELETE FROM local_supplement_plan_items WHERE supplement_plan_local_id = ?', [localId]);
  await db.runAsync('DELETE FROM local_supplement_checkins WHERE supplement_plan_local_id = ?', [localId]);
  await db.runAsync('DELETE FROM local_supplement_plans WHERE local_id = ? AND user_id = ?', [localId, userId]);
  await enqueueDelete('supplement_plan', localId, !!row?.server_id);
}

export async function checkInSupplement(planLocalId, date, taken, note) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync(
    `INSERT INTO local_supplement_checkins (user_id, supplement_plan_local_id, date, taken, note, synced)
     VALUES (?,?,?,?,?,0)
     ON CONFLICT(supplement_plan_local_id, date) DO UPDATE SET
       taken = excluded.taken, note = excluded.note, synced = 0`,
    [userId, planLocalId, date, taken ? 1 : 0, note ?? null]
  );
  await enqueueUpsert('supplement_checkin', `${planLocalId}|${date}`);
}

export async function listSupplementCheckins(planLocalId, limit = 30) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM local_supplement_checkins WHERE supplement_plan_local_id = ?
     ORDER BY date DESC LIMIT ?`, [planLocalId, limit]);
  return rows.map((c) => ({ date: c.date, taken: c.taken === 1, note: c.note }));
}