import { getDb } from './db';

export const DEFAULT_SETTINGS = {
  default_rest_seconds: 90,
  rpe_enabled: 1,
  weight_unit: 'kg',
  bar_weight: 20,
  plates: [20, 15, 10, 5, 2.5, 1.25],
  rest_timer_ends_at: null,
  rest_timer_total: null,
  rest_timer_label: null,
  streak_tolerance: 1,
  length_unit: 'cm',
  theme_mode: 'system',
  haptics_enabled: 1,
  vol_warning_threshold_high: 30,
  vol_warning_threshold_low: -30,
};

export async function getSettings() {
  const db = await getDb();
  try {
    let row = await db.getFirstAsync('SELECT * FROM user_settings WHERE id = 1');
    if (!row) {
      await db.runAsync('INSERT OR IGNORE INTO user_settings (id) VALUES (1)');
      row = {};
    }
    // The DB column is `unit`; the app reads/writes `weight_unit`. Alias
    // both ways so callers can use either name.
    const unit = row.unit ?? DEFAULT_SETTINGS.weight_unit;
    return {
      ...DEFAULT_SETTINGS,
      ...row,
      unit,
      weight_unit: unit,
      plates: JSON.parse(row.plates || 'null') || DEFAULT_SETTINGS.plates,
    };
  } catch (e) {
    if (String(e).includes('no such table')) {
      await db.execAsync(`CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_rest_seconds INTEGER NOT NULL DEFAULT 90,
        rpe_enabled INTEGER NOT NULL DEFAULT 1,
        unit TEXT NOT NULL DEFAULT 'kg',
        bar_weight REAL NOT NULL DEFAULT 20,
        plates TEXT NOT NULL DEFAULT '[20,15,10,5,2.5,1.25]',
        rest_timer_ends_at INTEGER,
        rest_timer_total INTEGER,
        rest_timer_label TEXT
      )`);
      await db.runAsync('INSERT OR IGNORE INTO user_settings (id) VALUES (1)');
      return DEFAULT_SETTINGS;
    }
    throw e;
  }
}

export async function updateSettings(patch) {
  const db = await getDb();
  const allowed = ['default_rest_seconds', 'rpe_enabled', 'weight_unit', 'unit', 'bar_weight', 'rest_timer_ends_at', 'rest_timer_total', 'rest_timer_label', 'streak_tolerance', 'length_unit', 'theme_mode', 'haptics_enabled', 'vol_warning_threshold_high', 'vol_warning_threshold_low'];
  const updates = { ...patch };
  // weight_unit and unit are the same setting (DB column: unit)
  if (updates.weight_unit !== undefined) {
    updates.unit = updates.weight_unit;
    delete updates.weight_unit;
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    await db.runAsync(`UPDATE user_settings SET ${k} = ? WHERE id = 1`, [v]);
  }
  if (patch.plates !== undefined) {
    await db.runAsync('UPDATE user_settings SET plates = ? WHERE id = 1', [
      JSON.stringify(patch.plates),
    ]);
  }
  return getSettings();
}