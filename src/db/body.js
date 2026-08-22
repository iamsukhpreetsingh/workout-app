// import { getDb } from './db';

// export const BODY_METRIC_TYPES = [
//   { type: 'weight', label: 'Body Weight', unit: 'kg' },
//   { type: 'body_fat_pct', label: 'Body Fat', unit: '%' },
//   { type: 'waist', label: 'Waist', unit: 'cm' },
//   { type: 'chest', label: 'Chest', unit: 'cm' },
//   { type: 'hips', label: 'Hips', unit: 'cm' },
//   { type: 'arm_l', label: 'Left Arm', unit: 'cm' },
//   { type: 'arm_r', label: 'Right Arm', unit: 'cm' },
//   { type: 'thigh_l', label: 'Left Thigh', unit: 'cm' },
//   { type: 'thigh_r', label: 'Right Thigh', unit: 'cm' },
//   { type: 'neck', label: 'Neck', unit: 'cm' },
// ];

// export async function logBodyMetric(date, metricType, value, unit) {
//   const db = await getDb();
//   await db.runAsync(
//     `INSERT INTO body_metrics (date, metric_type, value, unit) VALUES (?, ?, ?, ?)
//      ON CONFLICT(date, metric_type) DO UPDATE SET value = ?, unit = ?`,
//     [date, metricType, value, unit, value, unit]
//   );
// }

// export async function getBodyMetrics(metricType) {
//   const db = await getDb();
//   return db.getAllAsync(
//     `SELECT * FROM body_metrics WHERE metric_type = ? ORDER BY date ASC`,
//     [metricType]
//   );
// }

// export async function getLatestBodyMetric(metricType) {
//   const db = await getDb();
//   return db.getFirstAsync(
//     `SELECT * FROM body_metrics WHERE metric_type = ? ORDER BY date DESC LIMIT 1`,
//     [metricType]
//   );
// }

// export async function getBodyWeightHistory() {
//   const db = await getDb();
//   return db.getAllAsync(
//     `SELECT * FROM body_metrics WHERE metric_type = 'weight' ORDER BY date ASC`
//   );
// }

// export async function getUnsyncedMeasurements() {
//   const db = await getDb();
//   return db.getAllAsync('SELECT date, metric_type, value, unit FROM body_metrics WHERE synced = 0');
// }

// export async function markMeasurementsSynced(dates /* array of [date, metric_type] */) {
//   if (!dates.length) return;
//   const db = await getDb();
//   for (const [date, metric_type] of dates) {
//     await db.runAsync(
//       'UPDATE body_metrics SET synced = 1 WHERE date = ? AND metric_type = ?',
//       [date, metric_type]
//     );
//   }
// }

// export async function markAllMeasurementsUnsynced() {
//   const db = await getDb();
//   await db.runAsync('UPDATE body_metrics SET synced = 0');
// }

// export async function getTodayBodyMetric(metricType) {
//   const today = new Date().toISOString().split('T')[0];
//   const db = await getDb();
//   return db.getFirstAsync(
//     `SELECT * FROM body_metrics WHERE metric_type = ? AND date = ?`,
//     [metricType, today]
//   );
// }

// export async function getAllBodyMetricsForDate(date) {
//   const db = await getDb();
//   return db.getAllAsync(
//     `SELECT * FROM body_metrics WHERE date = ?`,
//     [date]
//   );
// }




import { getDb } from './db';
import { getCurrentUserId } from './userId';
import { enqueueUpsert } from '../lib/syncEngine';

export const BODY_METRIC_TYPES = [
  { type: 'weight', label: 'Body Weight', unit: 'kg' },
  { type: 'body_fat_pct', label: 'Body Fat', unit: '%' },
  { type: 'waist', label: 'Waist', unit: 'cm' },
  { type: 'chest', label: 'Chest', unit: 'cm' },
  { type: 'hips', label: 'Hips', unit: 'cm' },
  { type: 'arm_l', label: 'Left Arm', unit: 'cm' },
  { type: 'arm_r', label: 'Right Arm', unit: 'cm' },
  { type: 'thigh_l', label: 'Left Thigh', unit: 'cm' },
  { type: 'thigh_r', label: 'Right Thigh', unit: 'cm' },
  { type: 'neck', label: 'Neck', unit: 'cm' },
];

// Writes are user-scoped (the v23 rebuild added user_id + a proper UNIQUE
// constraint), always reset synced=0, and queue a backup upsert. Reads are
// legacy-tolerant: pre-upgrade rows have NULL user_id and stay visible
// until adoptLegacyMetrics() (called at login) claims them for the current
// user — this prevents history from vanishing mid-upgrade.
export async function logBodyMetric(date, metricType, value, unit) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return; // body logging requires a logged-in user
  await db.runAsync(
    `INSERT INTO body_metrics (user_id, date, metric_type, value, unit, synced)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(user_id, date, metric_type) DO UPDATE SET
       value = excluded.value, unit = excluded.unit, synced = 0`,
    [userId, date, metricType, value, unit]
  );
  // entity id is the composite natural key "date|metric_type"
  await enqueueUpsert('measurement', `${date}|${metricType}`);
}

export async function getBodyMetrics(metricType) {
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? AND (user_id = ? OR user_id IS NULL) ORDER BY date ASC`,
    [metricType, userId]
  );
}

export async function getLatestBodyMetric(metricType) {
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getFirstAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? AND (user_id = ? OR user_id IS NULL) ORDER BY date DESC LIMIT 1`,
    [metricType, userId]
  );
}

export async function getBodyWeightHistory() {
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE metric_type = 'weight' AND (user_id = ? OR user_id IS NULL) ORDER BY date ASC`,
    [userId]
  );
}

export async function getUnsyncedMeasurements() {
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getAllAsync(
    `SELECT date, metric_type, value, unit FROM body_metrics
     WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)`,
    [userId]
  );
}

export async function markMeasurementsSynced(dates /* array of [date, metric_type] */) {
  if (!dates.length) return;
  const db = await getDb();
  const userId = getCurrentUserId();
  for (const [date, metric_type] of dates) {
    await db.runAsync(
      'UPDATE body_metrics SET synced = 1 WHERE date = ? AND metric_type = ? AND (user_id = ? OR user_id IS NULL)',
      [date, metric_type, userId]
    );
  }
}

export async function markAllMeasurementsUnsynced() {
  const db = await getDb();
  await db.runAsync('UPDATE body_metrics SET synced = 0');
}

export async function getTodayBodyMetric(metricType) {
  const today = new Date().toISOString().split('T')[0];
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getFirstAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? AND date = ? AND (user_id = ? OR user_id IS NULL)`,
    [metricType, today, userId]
  );
}

export async function getAllBodyMetricsForDate(date) {
  const db = await getDb();
  const userId = getCurrentUserId();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE date = ? AND (user_id = ? OR user_id IS NULL)`,
    [date, userId]
  );
}

// One-time adoption at login: claims pre-upgrade (user_id NULL) rows for
// the logging-in user. Rows that collide with an already-owned row for the
// same date+metric are dropped — the owned row is the newer write. Any
// still-unsynced owned rows are enqueued for backup.
export async function adoptLegacyMetrics(userId) {
  if (!userId) return;
  const db = await getDb();
  await db.runAsync(
    `UPDATE body_metrics SET user_id = ?
     WHERE user_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM body_metrics b2
         WHERE b2.user_id = ? AND b2.date = body_metrics.date
           AND b2.metric_type = body_metrics.metric_type
       )`,
    [userId, userId]
  );
  await db.runAsync('DELETE FROM body_metrics WHERE user_id IS NULL');
  const rows = await db.getAllAsync(
    'SELECT date, metric_type FROM body_metrics WHERE user_id = ? AND synced = 0',
    [userId]
  );
  for (const r of rows) {
    await enqueueUpsert('measurement', `${r.date}|${r.metric_type}`);
  }
}