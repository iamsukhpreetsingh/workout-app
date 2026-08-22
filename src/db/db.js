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
    source_assigned_plan_id TEXT NULL,
    local_session_id TEXT NULL,
    user_id TEXT NOT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS session_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    position INTEGER NOT NULL,
    rest_seconds INTEGER NOT NULL DEFAULT 90, group_id TEXT NULL, notes TEXT NULL, muscle_group TEXT NULL
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
  await db.execAsync(`CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
    payload TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'COMPLETED', 'FAILED'))
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS sync_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sync_mode TEXT NOT NULL DEFAULT 'auto' CHECK (sync_mode IN ('auto', 'manual', 'local')),
    last_synced_at INTEGER,
    sync_enabled INTEGER NOT NULL DEFAULT 1
  );`);
  await db.runAsync('INSERT OR IGNORE INTO sync_settings (id) VALUES (1)');
  // const count = await db.getFirstAsync('SELECT COUNT(*) AS c FROM exercises');
  // if (count.c === 0) {
  //   for (const ex of SEED_EXERCISES) {
  //     await db.runAsync(
  //       'INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES (?, ?)',
  //       [ex.name, ex.muscle]
  //     );
  //   }
  // }
    // Seed the exercise library. Runs UNCONDITIONALLY on every launch:
  // INSERT OR IGNORE makes it a no-op for rows that already exist, and
  // unconditional execution HEALS devices whose seed silently failed.
  // BUGFIX: this used to bind `ex.muscle`, but the seed data's key is
  // `muscle_group` — every insert put NULL into a NOT NULL column and
  // INSERT OR IGNORE silently skipped ALL 39 rows, leaving fresh installs
  // with an empty exercise library.
  for (const ex of SEED_EXERCISES) {
    await db.runAsync(
      'INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES (?, ?)',
      [ex.name, ex.muscle_group]
    );
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
  await addColumnSafe(db, 'workout_sessions', 'user_id', 'TEXT');
  await addColumnSafe(db, 'user_settings', 'streak_tolerance', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnSafe(db, 'workout_plans', 'user_id', 'TEXT');
  await addColumnSafe(db, 'workout_plans', 'tags', 'TEXT');
  // Delete legacy plans without user_id
  await db.runAsync('DELETE FROM workout_plans WHERE user_id IS NULL OR user_id = ""');
  await addColumnSafe(db, 'user_settings', 'theme_mode', "TEXT NOT NULL DEFAULT 'system'");
  await addColumnSafe(db, 'user_settings', 'length_unit', "TEXT NOT NULL DEFAULT 'cm'");
  await addColumnSafe(db, 'exercises', 'user_id', 'TEXT');

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
      end_time INTEGER, duration_sec INTEGER, notes TEXT, plan_id INTEGER,
      user_id TEXT NOT NULL
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
    await addColumnSafe(db, 'session_exercises', 'muscle_group', 'TEXT NULL');
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
    );`);
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
    );`);
  },
  // v19: measurement sync flags
  async (db) => {
    await addColumnSafe(db, 'body_metrics', 'synced', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v20: user_id for workout plans - fixes user isolation bug
  async (db) => {
    await addColumnSafe(db, 'workout_plans', 'user_id', 'TEXT NOT NULL');
    await db.runAsync('DELETE FROM workout_plans WHERE user_id IS NULL OR user_id = ""');
  },
  // v21: user_id for workout_sessions - fixes user isolation bug in sessions
  async (db) => {
    await addColumnSafe(db, 'workout_sessions', 'user_id', 'TEXT');
    await db.runAsync('DELETE FROM workout_sessions WHERE user_id IS NULL OR user_id = ""');
  },
  // v22: sync queue and sync settings for offline-first sync
  async (db) => {
    await addColumnSafe(db, 'workout_sessions', 'local_session_id', 'TEXT NULL');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'COMPLETED', 'FAILED'))
    );`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sync_mode TEXT NOT NULL DEFAULT 'auto' CHECK (sync_mode IN ('auto', 'manual', 'local')),
      last_synced_at INTEGER,
      sync_enabled INTEGER NOT NULL DEFAULT 1
    );`);
    await db.runAsync('INSERT OR IGNORE INTO sync_settings (id) VALUES (1)');
  },
  // v23: offline-first sync upgrade, part 1 — sync-tracking columns on every
  // entity, user-scoped body_metrics (full table rebuild — SQLite cannot
  // alter a UNIQUE constraint in place), dependency/backoff columns on
  // sync_queue, and the restore-gate settings fields.
  //
  // Sessions are RESET to synced=0 on purpose: they were only ever synced to
  // the REDACTED trainer tables, never to the new full-fidelity backup — so
  // every existing session must be re-uploaded once (the D3 backfill).
  // The body_metrics rebuild is guarded so a partially-failed run (or a
  // re-run) can never lose data.
  async (db) => {
    await addColumnSafe(db, 'exercises', 'local_id', 'TEXT');
    await addColumnSafe(db, 'exercises', 'server_id', 'TEXT');
    await addColumnSafe(db, 'exercises', 'synced', 'INTEGER NOT NULL DEFAULT 1');
    // await db.runAsync('UPDATE exercises SET synced = 0 WHERE is_custom = 1');
    await db.runAsync('UPDATE exercises SET synced = 0 WHERE is_custom = 1 AND synced = 1 AND server_id IS NULL');
    await addColumnSafe(db, 'workout_plans', 'local_id', 'TEXT');
    await addColumnSafe(db, 'workout_plans', 'server_id', 'TEXT');
    await addColumnSafe(db, 'workout_plans', 'synced', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnSafe(db, 'plan_exercises', 'local_id', 'TEXT');

    await addColumnSafe(db, 'workout_sessions', 'local_id', 'TEXT');
    await addColumnSafe(db, 'workout_sessions', 'server_id', 'TEXT');
    // await db.runAsync('UPDATE workout_sessions SET synced = 0');
        await db.runAsync('UPDATE workout_sessions SET synced = 0 WHERE synced = 1 AND server_id IS NULL');
    await addColumnSafe(db, 'session_exercises', 'local_id', 'TEXT');
    await addColumnSafe(db, 'sets', 'local_id', 'TEXT');

    await addColumnSafe(db, 'personal_records', 'local_id', 'TEXT');
    await addColumnSafe(db, 'personal_records', 'server_id', 'TEXT');
    await addColumnSafe(db, 'personal_records', 'synced', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnSafe(db, 'personal_records', 'exercise_name', 'TEXT');
    await db.runAsync(`UPDATE personal_records SET exercise_name = (
      SELECT name FROM exercises WHERE exercises.id = personal_records.exercise_id
    ) WHERE exercise_name IS NULL`);

    await addColumnSafe(db, 'progress_photos', 'local_id', 'TEXT');
    await addColumnSafe(db, 'progress_photos', 'server_id', 'TEXT');
    await addColumnSafe(db, 'progress_photos', 'synced', 'INTEGER NOT NULL DEFAULT 0');

    // body_metrics rebuild: adds user_id + UNIQUE(user_id, date, metric_type).
    // Guarded — runs only if the current table lacks user_id, and survives a
    // crashed earlier attempt at any step.
    const bmCols = await db.getAllAsync("PRAGMA table_info('body_metrics')");
    const hasUserIdCol = bmCols.some((c) => c.name === 'user_id');
    if (!hasUserIdCol) {
      await db.execAsync(`CREATE TABLE IF NOT EXISTS body_metrics_v23 (
        id INTEGER PRIMARY KEY,
        user_id TEXT,
        date TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        local_id TEXT,
        server_id TEXT,
        UNIQUE(user_id, date, metric_type)
      )`);
      if (bmCols.length) {
        await db.runAsync(`INSERT OR IGNORE INTO body_metrics_v23
          (id, date, metric_type, value, unit, synced)
          SELECT id, date, metric_type, value, unit, synced FROM body_metrics`);
      }
      await db.execAsync('DROP TABLE IF EXISTS body_metrics');
      await db.execAsync('ALTER TABLE body_metrics_v23 RENAME TO body_metrics');
    }

    // sync_queue: dependency ordering + backoff bookkeeping
    await addColumnSafe(db, 'sync_queue', 'depends_on_entity_type', 'TEXT');
    await addColumnSafe(db, 'sync_queue', 'depends_on_local_id', 'TEXT');
    await addColumnSafe(db, 'sync_queue', 'last_attempt_at', 'INTEGER');

    // restore gate + local-only reminder + backfill bookkeeping
    await addColumnSafe(db, 'user_settings', 'restore_completed_at', 'TEXT');
    await addColumnSafe(db, 'user_settings', 'last_local_only_reminder_shown_at', 'TEXT');
    await addColumnSafe(db, 'user_settings', 'backfill_v1_done', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v24: offline-first sync upgrade, part 2 — local-first tables for entities
  // that previously had NO local storage (recipes, diet/supplement plans,
  // check-ins — all server-first until now, i.e. un-creatable offline) plus
  // the offline cache for trainer-assigned content. The cache is display-
  // only and one-way (server → device), staleness-tracked via
  // last_fetched_at; it is NEVER an upload source. All local_* tables are
  // user-scoped. Array-typed fields are stored as JSON text.
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_recipes (
      local_id TEXT PRIMARY KEY,
      server_id TEXT,
      user_id TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT,
      prep_notes TEXT,
      calories INTEGER, protein_g REAL, carbs_g REAL, fat_g REAL,
      serving_size TEXT, recipe_url TEXT, photo_path TEXT,
      ingredients TEXT NOT NULL DEFAULT '[]',
      allergens TEXT NOT NULL DEFAULT '[]',
      prep_time_minutes INTEGER, cook_time_minutes INTEGER, difficulty TEXT,
      suggested_meal_types TEXT NOT NULL DEFAULT '[]',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      alternate_servings TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_diet_plans (
      local_id TEXT PRIMARY KEY,
      server_id TEXT,
      user_id TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      notes TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      daily_calorie_target INTEGER,
      daily_protein_target INTEGER,
      daily_carbs_target INTEGER,
      daily_fat_target INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_diet_plan_days (
      local_id TEXT PRIMARY KEY,
      diet_plan_local_id TEXT NOT NULL,
      day_label TEXT,
      order_index INTEGER NOT NULL DEFAULT 0
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_diet_plan_meals (
      local_id TEXT PRIMARY KEY,
      diet_day_local_id TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      slot_note TEXT
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_diet_plan_meal_items (
      local_id TEXT PRIMARY KEY,
      diet_meal_local_id TEXT NOT NULL,
      local_recipe_id TEXT,
      name TEXT NOT NULL,
      calories INTEGER, protein_g REAL, carbs_g REAL, fat_g REAL,
      serving_size TEXT, recipe_url TEXT,
      quantity_multiplier REAL NOT NULL DEFAULT 1,
      client_note TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      photo_path TEXT,
      ingredients TEXT NOT NULL DEFAULT '[]',
      allergens TEXT NOT NULL DEFAULT '[]',
      prep_time_minutes INTEGER, cook_time_minutes INTEGER, difficulty TEXT,
      alternate_servings TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]'
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_diet_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      diet_plan_local_id TEXT NOT NULL,
      date TEXT NOT NULL,
      followed INTEGER NOT NULL,
      note TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      UNIQUE(diet_plan_local_id, date)
    )`);

    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_supplement_plans (
      local_id TEXT PRIMARY KEY,
      server_id TEXT,
      user_id TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      notes TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_supplement_plan_items (
      local_id TEXT PRIMARY KEY,
      supplement_plan_local_id TEXT NOT NULL,
      supplement_name TEXT NOT NULL,
      dosage TEXT,
      timing TEXT,
      notes TEXT,
      order_index INTEGER NOT NULL DEFAULT 0
    )`);
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_supplement_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      supplement_plan_local_id TEXT NOT NULL,
      date TEXT NOT NULL,
      taken INTEGER NOT NULL,
      note TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      UNIQUE(supplement_plan_local_id, date)
    )`);

    await db.execAsync(`CREATE TABLE IF NOT EXISTS sync_cache (
      user_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      last_fetched_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, cache_key)
    )`);
  },
  // v25: one-time sync_queue reset. The unified engine (syncEngine.js)
  // changes queue semantics completely (fresh payloads, dependency columns,
  // new entity types). Stale rows from the old ad-hoc system — including
  // degraded session payloads that could zero server-side data — are
  // discarded. The queue is a derived structure: nothing is lost, because
  // all durable state lives in the entity tables' synced/server_id flags.
  async (db) => {
    // await db.runAsync('DELETE FROM sync_queue');
        // legacy rows only — the old system always stored payloads; the new
    // engine never does. New-format pending rows survive this wipe.
    await db.runAsync('DELETE FROM sync_queue WHERE payload IS NOT NULL');
  },
    // v26: user-scoped custom exercises — a custom exercise created by one
  // account is invisible to other accounts on the same device. Seed
  // exercises keep user_id NULL (device-shared by design). Existing
  // customs (user_id NULL) are claimed by the first account to log in
  // after this upgrade (adoptLegacyCustomExercises in backfill.js).
  async (db) => {
    await addColumnSafe(db, 'exercises', 'user_id', 'TEXT');
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

// async function initDb() {
//   const db = await SQLite.openDatabaseAsync('workout.db');
//   await db.execAsync('PRAGMA journal_mode = WAL;');
//   let { version } = await getFirstUserVersion(db);
//   try {
//     for (let v = version; v < MIGRATIONS.length; v++) {
//       await MIGRATIONS[v](db);
//       await db.runAsync(`PRAGMA user_version = ${v + 1}`);
//     }
//   } catch (e) {
//     // A failed migration must not wedge getDb() forever — ensureSchema
//     // self-heals missing tables/columns, and the failed migration will be
//     // retried on next launch (user_version only advances on success).
//     console.warn('migration skipped:', e.message || e);
//   }
//   await ensureSchema(db);
//   dbInstance = db;
//   return db;
// }

// async function getFirstUserVersion(db) {
//   try {
//     return await db.getFirstAsync('PRAGMA user_version');
//   } catch {
//     return { version: 0 };
//   }
// }




// async function initDb() {
//   const db = await SQLite.openDatabaseAsync('workout.db');
//   await db.execAsync('PRAGMA journal_mode = WAL;');

//   // NOTE: the migration runner had a silent bug since the app was first
//   // built — it destructured the wrong key from PRAGMA user_version, so
//   // versioned migrations NEVER ran; every schema change actually came from
//   // ensureSchema()'s self-healing. Fixed here: read the correct key, and
//   // detect existing installs (tables present, counter at 0) so we skip the
//   // historical v1–v22 (their schema already exists via self-heal) and go
//   // straight to v23.
//   const row = await getFirstUserVersion(db);
//   let version = Number(row?.user_version ?? row?.version ?? 0) || 0;
//   console.log('[DB] user_version at launch:', version);

//   if (version < 23) {
//     let existing = [];
//     try {
//       existing = await db.getAllAsync(
//         "SELECT name FROM sqlite_master WHERE type='table' AND name='workout_sessions'"
//       );
//     } catch {}
//     if (existing.length) {
//       version = 22; // pre-v23 schema is guaranteed present via self-heal
//       console.log('[DB] existing install detected — starting at v23');
//     }
//   }

//   try {
//     for (let v = version; v < MIGRATIONS.length; v++) {
//       await MIGRATIONS[v](db);
//       await db.runAsync(`PRAGMA user_version = ${v + 1}`);
//       console.log('[DB] applied migration v' + (v + 1));
//     }
//   } catch (e) {
//     // A failed migration must not wedge getDb() forever — ensureSchema
//     // self-heals missing tables/columns, and the failed migration will be
//     // retried on next launch (user_version only advances on success).
//     console.warn('migration skipped:', e.message || e);
//   }
//   await ensureSchema(db);
//   dbInstance = db;
//   return db;
// }



async function initDb() {
  const db = await SQLite.openDatabaseAsync('workout.db');
  await db.execAsync('PRAGMA journal_mode = WAL;');

  // Self-heal BEFORE migrating. The historical v1–v22 migrations were
  // written incrementally against an already-self-healed schema and were
  // never runnable in sequence from scratch (v6's PR backfill reads
  // sets.completed, a column v14 creates — unnoticed for years because the
  // original runner never executed any migration). ensureSchema is fully
  // idempotent and guarantees every migration's assumptions hold. It runs
  // again after the loop, unchanged.
  await ensureSchema(db);

  const row = await getFirstUserVersion(db);
  const version = Number(row?.user_version ?? row?.version ?? 0) || 0;
  console.log('[DB] user_version at launch:', version);

  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      await MIGRATIONS[v](db);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
      console.log('[DB] applied migration v' + (v + 1));
    }
  } catch (e) {
    // A failed migration must not wedge getDb() forever — ensureSchema has
    // already run, and the failed migration retries on next launch
    // (user_version only advances on success).
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
    return { user_version: 0 };
  }
}