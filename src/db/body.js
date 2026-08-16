import { getDb } from './db';

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

export async function logBodyMetric(date, metricType, value, unit) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO body_metrics (date, metric_type, value, unit) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, metric_type) DO UPDATE SET value = ?, unit = ?`,
    [date, metricType, value, unit, value, unit]
  );
}

export async function getBodyMetrics(metricType) {
  const db = await getDb();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? ORDER BY date ASC`,
    [metricType]
  );
}

export async function getLatestBodyMetric(metricType) {
  const db = await getDb();
  return db.getFirstAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? ORDER BY date DESC LIMIT 1`,
    [metricType]
  );
}

export async function getBodyWeightHistory() {
  const db = await getDb();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE metric_type = 'weight' ORDER BY date ASC`
  );
}

export async function getUnsyncedMeasurements() {
  const db = await getDb();
  return db.getAllAsync('SELECT date, metric_type, value, unit FROM body_metrics WHERE synced = 0');
}

export async function markMeasurementsSynced(dates /* array of [date, metric_type] */) {
  if (!dates.length) return;
  const db = await getDb();
  for (const [date, metric_type] of dates) {
    await db.runAsync(
      'UPDATE body_metrics SET synced = 1 WHERE date = ? AND metric_type = ?',
      [date, metric_type]
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
  return db.getFirstAsync(
    `SELECT * FROM body_metrics WHERE metric_type = ? AND date = ?`,
    [metricType, today]
  );
}

export async function getAllBodyMetricsForDate(date) {
  const db = await getDb();
  return db.getAllAsync(
    `SELECT * FROM body_metrics WHERE date = ?`,
    [date]
  );
}