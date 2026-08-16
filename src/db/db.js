import * as SQLite from 'expo-sqlite';
import { SEED_EXERCISES } from '../seed/exercises';

let dbInstance = null;
let dbInitPromise = null;

// Single init promise — prevents the race condition where concurrent callers
// to getDb() receive the db connection before migrations finish.
export async function getDb() {
  if (dbInstance) return dbInstance;
  if (!dbInitPromise) dbInitPromise = initDb();
  return dbInitPromise;
}

// ALTER TABLE ADD COLUMN — silently no-ops if the column already exists.
async function addColumnSafe(db, table, col, def) {
  try {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
  }
}

// Self-heal the base tables. A database can end up with user_version
// recorded past the baseline migration while some tables are missing (e.g.
// a crashed first-run mid-migration). CREATE IF NOT EXISTS here makes any
// such DB whole before ALTERs/migrations touch it.
async function ensureBaseTables(db) {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    muscle_group TEXT NOT NULL,
    is_custom INTEGER NOT NULL DEFAULT 0,
    instructions TEXT NULL,
    thumbnail_path TEXT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS workout_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL,
    folder_id INTEGER NULL REFERENCES plan_folders(id),
    user_id TEXT NOT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS plan_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position INTEGER NOT NULL, target_sets INTEGER NOT NULL DEFAULT 3,
    rest_seconds INTEGER NOT NULL DEFAULT 90, group_id TEXT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS workout_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, start_time INTEGER NOT NULL,
    end_time INTEGER, duration_sec INTEGER, notes TEXT, plan_id INTEGER,
    synced INTEGER NOT NULL DEFAULT 0, sync_attempted_at TEXT NULL,
    source_assigned_plan_id TEXT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS session_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position INTEGER NOT NULL,
    rest_seconds INTEGER NOT NULL DEFAULT 90, group_id TEXT NULL, notes TEXT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_exercise_id INTEGER NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
    is_warmup INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL,
    rpe REAL NULL,
    set_type TEXT NOT NULL DEFAULT 'working',
    completed INTEGER NOT NULL DEFAULT 1
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_rest_seconds INTEGER NOT NULL DEFAULT 90,
    rpe_enabled INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'kg',
    weight_unit TEXT,
    bar_weight REAL NOT NULL DEFAULT 20,
    plates TEXT NOT NULL DEFAULT '[20,15,10,5,2.5,1.25]',
    rest_timer_ends_at INTEGER,
    rest_timer_total INTEGER,
    rest_timer_label TEXT,
    streak_tolerance INTEGER NOT NULL DEFAULT 1,
    theme_mode TEXT NOT NULL DEFAULT 'system',
    haptics_enabled INTEGER NOT NULL DEFAULT 1,
    length_unit TEXT NOT NULL DEFAULT 'cm',
    vol_warning_threshold_high INTEGER NOT NULL DEFAULT 30,
    vol_warning_threshold_low INTEGER NOT NULL DEFAULT -30
  );`);
  await db.runAsync('INSERT OR IGNORE INTO user_settings (id) VALUES (1)');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS active_workout (
    id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS plan_folders (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER DEFAULT 0
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS personal_records (
    id INTEGER PRIMARY KEY, exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    record_type TEXT NOT NULL, value REAL NOT NULL, secondary_value REAL,
    set_id INTEGER NOT NULL REFERENCES sets(id), achieved_at TEXT NOT NULL,
    UNIQUE(exercise_id, record_type, secondary_value)
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS body_metrics (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, metric_type TEXT NOT NULL,
    value REAL NOT NULL, unit TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, metric_type)
  );`);
  await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS pinned_routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('self', 'trainer_assigned')),
    routine_ref_id TEXT NOT NULL,
    pinned_at TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_type, routine_ref_id)
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS progress_photos (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, file_path TEXT NOT NULL,
    angle TEXT, created_at TEXT NOT NULL
  );`);
  const count = await db.getFirstAsync('SELECT COUNT(*) AS c FROM exercises');
  if (count.c === 0) {
    for (const ex of SEED_EXERCISES) {
      await db.runAsync(
        'INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES (?, ?)',
        [ex.name, ex.muscle_group]
      );
    }
  }
}

// Ensure critical columns exist (runs after migrations)
async function ensureSchema(db) {
  await ensureBaseTables(db);
  await addColumnSafe(db, 'sets', 'set_type', "TEXT NOT NULL DEFAULT 'working'");
  await addColumnSafe(db, 'sets', 'rpe', 'REAL NULL');
  await addColumnSafe(db, 'plan_exercises', 'rest_seconds', 'INTEGER NOT NULL DEFAULT 90');
  await addColumnSafe(db, 'plan_exercises', 'group_id', 'TEXT NULL');
  await addColumnSafe(db, 'session_exercises', 'rest_seconds', 'INTEGER NOT NULL DEFAULT 90');
  await addColumnSafe(db, 'session_exercises', 'group_id', 'TEXT NULL');
  await addColumnSafe(db, 'session_exercises', 'notes', 'TEXT NULL');
  await addColumnSafe(db, 'sets', 'completed', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnSafe(db, 'workout_sessions', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnSafe(db, 'workout_sessions', 'sync_attempted_at', 'TEXT NULL');
  await addColumnSafe(db, 'workout_sessions', 'source_assigned_plan_id', 'TEXT NULL');
  await addColumnSafe(db, 'user_settings', 'streak_tolerance', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnSafe(db, 'workout_plans', 'user_id', 'TEXT');
  // Delete legacy plans without user_id
  await db.runAsync('DELETE FROM workout_plans WHERE user_id IS NULL OR user_id = ""');
  await addColumnSafe(db, 'user_settings', 'theme_mode', "TEXT NOT NULL DEFAULT 'system'");
  await addColumnSafe(db, 'user_settings', 'length_unit', "TEXT NOT NULL DEFAULT 'cm'");

  const tables = ['personal_records', 'body_metrics', 'progress_photos'];
  for (const table of tables) {
    try {
      await db.getFirstAsync(`SELECT 1 FROM ${table} WHERE 0`);
    } catch (e) {
      if (String(e).includes('no such table')) {
        if (table === 'personal_records') {
          await db.execAsync(`CREATE TABLE IF NOT EXISTS personal_records (
            id INTEGER PRIMARY KEY, exercise_id INTEGER NOT NULL REFERENCES exercises(id),
            record_type TEXT NOT NULL, value REAL NOT NULL, secondary_value REAL,
            set_id INTEGER NOT NULL REFERENCES sets(id), achieved_at TEXT NOT NULL,
            UNIQUE(exercise_id, record_type, secondary_value)
          )`);
        } else if (table === 'body_metrics') {
          await db.execAsync(`CREATE TABLE IF NOT EXISTS body_metrics (
            id INTEGER PRIMARY KEY, date TEXT NOT NULL, metric_type TEXT NOT NULL,
            value REAL NOT NULL, unit TEXT NOT NULL, UNIQUE(date, metric_type)
          )`);
        } else if (table === 'progress_photos') {
          await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS pinned_routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('self', 'trainer_assigned')),
    routine_ref_id TEXT NOT NULL,
    pinned_at TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_type, routine_ref_id)
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS progress_photos (
            id INTEGER PRIMARY KEY, date TEXT NOT NULL, file_path TEXT NOT NULL,
            angle TEXT, created_at TEXT NOT NULL
          )`);
        }
      }
    }
  }
}

const MIGRATIONS = [
  // v1: baseline schema
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      muscle_group TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS workout_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS plan_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      position INTEGER NOT NULL, target_sets INTEGER NOT NULL DEFAULT 3
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS workout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, start_time INTEGER NOT NULL,
      end_time INTEGER, duration_sec INTEGER, notes TEXT, plan_id INTEGER
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS session_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      position INTEGER NOT NULL
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_exercise_id INTEGER NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
      weight REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
      is_warmup INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
    );`);
    const count = await db.getFirstAsync('SELECT COUNT(*) AS c FROM exercises');
    if (count.c === 0) {
      for (const ex of SEED_EXERCISES) {
        await db.runAsync(
          'INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES (?, ?)',
          [ex.name, ex.muscle_group]
        );
      }
    }
  },
  // v2: rest timer defaults + user settings
  async (db) => {
    await addColumnSafe(db, 'plan_exercises', 'rest_seconds', 'INTEGER NOT NULL DEFAULT 90');
    await addColumnSafe(db, 'session_exercises', 'rest_seconds', 'INTEGER NOT NULL DEFAULT 90');
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
    );`);
    await db.runAsync('INSERT OR IGNORE INTO user_settings (id) VALUES (1)');
  },
  // v3: superset / circuit grouping
  async (db) => {
    await addColumnSafe(db, 'plan_exercises', 'group_id', 'TEXT NULL');
    await addColumnSafe(db, 'session_exercises', 'group_id', 'TEXT NULL');
  },
  // v4: RPE per set
  async (db) => {
    await addColumnSafe(db, 'sets', 'rpe', 'REAL NULL');
  },
  // v5: set types; backfill legacy is_warmup flag
  async (db) => {
    await addColumnSafe(db, 'sets', 'set_type', "TEXT NOT NULL DEFAULT 'working'");
    await db.runAsync("UPDATE sets SET set_type = 'warmup' WHERE is_warmup = 1");
  },
  // v6: personal records
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS personal_records (
      id INTEGER PRIMARY KEY,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      record_type TEXT NOT NULL,
      value REAL NOT NULL,
      secondary_value REAL,
      set_id INTEGER NOT NULL REFERENCES sets(id),
      achieved_at TEXT NOT NULL,
      UNIQUE(exercise_id, record_type, secondary_value)
    );`);
    await backfillPRs(db);
  },
  // v7: body metrics
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS body_metrics (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      UNIQUE(date, metric_type)
    );`);
  },
  // v8: progress photos
  async (db) => {
    await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS pinned_routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('self', 'trainer_assigned')),
    routine_ref_id TEXT NOT NULL,
    pinned_at TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_type, routine_ref_id)
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS progress_photos (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      file_path TEXT NOT NULL,
      angle TEXT,
      created_at TEXT NOT NULL
    );`);
  },
  // v9: streak settings
  async (db) => {
    await addColumnSafe(db, 'user_settings', 'streak_tolerance', 'INTEGER NOT NULL DEFAULT 1');
  },
  // v10: unit system toggle, haptics, volume warnings
  async (db) => {
    await addColumnSafe(db, 'user_settings', 'weight_unit', "TEXT NOT NULL DEFAULT 'kg'");
    await addColumnSafe(db, 'user_settings', 'haptics_enabled', 'INTEGER NOT NULL DEFAULT 1');
    await addColumnSafe(db, 'user_settings', 'vol_warning_threshold_high', 'INTEGER NOT NULL DEFAULT 30');
    await addColumnSafe(db, 'user_settings', 'vol_warning_threshold_low', 'INTEGER NOT NULL DEFAULT -30');
  },
  // v11: exercise instructions and thumbnails
  async (db) => {
    await addColumnSafe(db, 'exercises', 'instructions', 'TEXT NULL');
    await addColumnSafe(db, 'exercises', 'thumbnail_path', 'TEXT NULL');
  },
  // v12: workout plan folders
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS plan_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      order_index INTEGER DEFAULT 0
    )`);
    await addColumnSafe(db, 'workout_plans', 'folder_id', 'INTEGER NULL REFERENCES plan_folders(id)');
  },
  // v13: per-exercise notes within a session
  async (db) => {
    await addColumnSafe(db, 'session_exercises', 'notes', 'TEXT NULL');
  },
  // v14: completed flag on sets — volume/PRs only count sets the user marked
  // done. Default 1 so historical sets keep counting after upgrade.
  async (db) => {
    await addColumnSafe(db, 'sets', 'completed', 'INTEGER NOT NULL DEFAULT 1');
  },
  // v15: persisted active workout (mini-player state survives app kills)
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS active_workout (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  // v16: aggregate session-summary sync flags
  async (db) => {
    await addColumnSafe(db, 'workout_sessions', 'synced', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnSafe(db, 'workout_sessions', 'sync_attempted_at', 'TEXT NULL');
  await addColumnSafe(db, 'workout_sessions', 'source_assigned_plan_id', 'TEXT NULL');
  },
  // v17: trainer-assigned origin — set when a session is started from an
  // assigned plan; drives the trainer/self-made color coding everywhere
  async (db) => {
    await addColumnSafe(db, 'workout_sessions', 'source_assigned_plan_id', 'TEXT NULL');
  },
  // v18: pinned routines (quick access from Home; spans local plans and
  // backend assigned plans, hence a dedicated table)
  async (db) => {
    await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS pinned_routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK (source_type IN ('self', 'trainer_assigned')),
      routine_ref_id TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_type, routine_ref_id)
    )`);
  },
  // v19: measurement sync flags
  async (db) => {
    await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v20: user_id for workout plans - fixes user isolation bug
  // Deletes all existing plans without user_id (option 2: clean slate)
  async (db) => {
    await addColumnSafe(db, 'workout_plans', 'user_id', 'TEXT NOT NULL');
    // Delete all plans that don't have a user_id (legacy data from before this fix)
    await db.runAsync('DELETE FROM workout_plans WHERE user_id IS NULL OR user_id = ""');
  },
];

async function backfillPRs(db) {
  const sets = await db.getAllAsync(`
    SELECT s.id AS set_id, s.weight, s.reps, se.exercise_id, sess.start_time
    FROM sets s
    JOIN session_exercises se ON s.session_exercise_id = se.id
    JOIN workout_sessions sess ON se.session_id = sess.id
    WHERE s.set_type != 'warmup' AND s.completed = 1
  `);

  for (const s of sets) {
    const e1rm = s.weight * (1 + s.reps / 30);
    const volume = s.weight * s.reps;

    await db.runAsync(
      `INSERT OR IGNORE INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'max_weight', ?, NULL, ?, ?)`,
      [s.exercise_id, s.weight, s.set_id, new Date(s.start_time).toISOString()]
    );

    await db.runAsync(
      `INSERT OR IGNORE INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'estimated_1rm', ?, NULL, ?, ?)`,
      [s.exercise_id, e1rm, s.set_id, new Date(s.start_time).toISOString()]
    );

    await db.runAsync(
      `INSERT OR IGNORE INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'max_volume_set', ?, ?, ?, ?)`,
      [s.exercise_id, volume, s.weight, s.set_id, new Date(s.start_time).toISOString()]
    );

    await db.runAsync(
      `INSERT OR IGNORE INTO personal_records (exercise_id, record_type, value, secondary_value, set_id, achieved_at)
       VALUES (?, 'max_reps_at_weight', ?, ?, ?, ?)`,
      [s.exercise_id, s.reps, s.weight, s.set_id, new Date(s.start_time).toISOString()]
    );
  }

  await db.runAsync(`DELETE FROM personal_records WHERE id NOT IN (
    SELECT pr.id FROM personal_records pr
    JOIN (
      SELECT exercise_id, record_type, COALESCE(secondary_value, -9999) AS sv, MAX(value) AS maxv
      FROM personal_records
      GROUP BY exercise_id, record_type, COALESCE(secondary_value, -9999)
    ) best ON pr.exercise_id = best.exercise_id AND pr.record_type = best.record_type 
      AND COALESCE(pr.secondary_value, -9999) = best.sv AND pr.value = best.maxv
  )`);
}

async function initDb() {
  const db = await SQLite.openDatabaseAsync('workout.db');
  await db.execAsync('PRAGMA journal_mode = WAL;');
  let { version } = await getFirstUserVersion(db);
  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      await MIGRATIONS[v](db);
      await db.runAsync(`PRAGMA user_version = ${v + 1}`);
    }
  } catch (e) {
    // A failed migration must not wedge getDb() forever — ensureSchema
    // self-heals missing tables/columns, and the failed migration will be
    // retried on next launch (user_version only advances on success).
    console.warn('migration skipped:', e.message || e);
  }
  await ensureSchema(db);
  dbInstance = db;
  return db;
}

async function getFirstUserVersion(db) {
  try {
    return await db.getFirstAsync('PRAGMA user_version');
  } catch {
    return { version: 0 };
  }
}
