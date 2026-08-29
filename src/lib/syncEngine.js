// src/lib/syncEngine.js
//
// THE unified sync engine (System 2). One module owns ALL upload logic for
// every syncable entity. UI code never calls a backend save endpoint
// directly — it writes local SQLite and enqueues here.
//
// Core rules (from the sync spec — do not weaken these):
//  - Payloads are built FRESH from the database at process time (never
//    trust a stored payload — this is what guarantees an edit can't be
//    overwritten by a stale queued copy).
//  - Dependency ordering: a child never syncs before its parent (checked
//    against local table state — authoritative).
//  - Retry backoff: 30s → 2m → 10m → 1h → stop after 5 attempts. A manual
//    sync trigger processes FAILED rows regardless of backoff/cap.
//  - Rows stuck in 'SYNCING' at launch (app died mid-sync) reset to PENDING.
//  - Deletes: never-backed-up entities are simply removed locally (no queue
//    row, no server call). Backed-up entities queue a server delete —
//    server delete endpoints are idempotent, so a delete can never 404-loop.
//  - Sync modes: 'local' never runs (not even manually); 'manual' runs only
//    on explicit trigger; 'auto' runs on foreground/reconnect/10-min timer.
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { api } from './api';
import { postSyncReport } from './adminTelemetry';

// ── admin telemetry (Phase 11): throttled queue-health reporting ────────
// Fire-and-forget: at most every 10 min, or immediately when something
// failed. Any error is swallowed inside postSyncReport.
const REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastReportAt = 0;
async function reportHealthToAdmin(force = false) {
  try {
    const now = Date.now();
    if (!force && now - lastReportAt < REPORT_INTERVAL_MS) return;
    lastReportAt = now;
    const status = await getEngineStatus();
    let failingItems = null;
    if ((status.failed_count || 0) > 0) {
      failingItems = (await getFailedItems()).slice(0, 20);
    }
    await postSyncReport({
      pendingCount: status.pending_count || 0,
      failedCount: status.failed_count || 0,
      failingItems,
    });
  } catch {}
}

const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
const MAX_ATTEMPTS = 5;
const BATCH_LIMIT = 200;

let connectivity = { isConnected: false, isInternetReachable: false };
let processing = false;
let timer = null;
let launched = false;

// ── settings ────────────────────────────────────────────────────────────
async function getSyncSettings() {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT * FROM sync_settings WHERE id = 1');
  return row || { sync_mode: 'auto' };
}

async function touchLastSynced() {
  const db = await getDb();
  await db.runAsync('UPDATE sync_settings SET last_synced_at = ? WHERE id = 1', [Date.now()]);
}






// ── queue writes ─────────────────────────────────────────────────────────
// Dedup-in-place: an existing pending row for the same entity is updated,
// never duplicated. Editing the same plan 5 times = 1 queue row.
// These functions NEVER throw — a queue problem must never block or fail a
// local save (local-first is the core contract). Failures are logged; the
// Phase-D backfill sweep is the safety net for anything missed.
export async function enqueueUpsert(entityType, localId, dependsOn = null) {
  if (!getCurrentUserId()) return;
  const db = await getDb();
  const now = Date.now();
  try {
    const existing = await db.getFirstAsync(
      `SELECT id FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','SYNCING','FAILED')`,
      [entityType, String(localId)]
    );
    if (existing) {
      await db.runAsync(
        `UPDATE sync_queue SET operation = 'UPDATE', status = 'PENDING', retry_count = 0,
           last_error = NULL, updated_at = ?, last_attempt_at = NULL,
           depends_on_entity_type = ?, depends_on_local_id = ?
         WHERE id = ?`,
        [now, dependsOn ? dependsOn.entityType : null, dependsOn ? String(dependsOn.localId) : null, existing.id]
      );
      return;
    }
    await db.runAsync(
      `INSERT INTO sync_queue (operation_id, entity_type, entity_id, operation, payload,
         created_at, updated_at, status, depends_on_entity_type, depends_on_local_id)
       VALUES (?, ?, ?, 'CREATE', NULL, ?, ?, 'PENDING', ?, ?)`,
      [
        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        entityType, String(localId), now, now,
        dependsOn ? dependsOn.entityType : null,
        dependsOn ? String(dependsOn.localId) : null,
      ]
    );
//   } catch (e) {
//     console.error('[SYNC] enqueueUpsert failed (local save unaffected):', e.message);
//   }
// }
  } catch (e) {
    console.error('[SYNC] enqueueUpsert failed (local save unaffected):', e.message);
  }
  kickQueue(); // debounced auto-sync attempt (no-op outside auto mode)
}





//   } catch (e) {
//     console.error('[SYNC] enqueueDelete failed (local delete unaffected):', e.message);
//   }
// hadServerBackup: the caller checks (BEFORE deleting the local row) whether
// this entity was ever backed up (server_id set). Never-backed-up deletes
// are clean local removals — no queue row, no server call.
// snapshot (optional): small JSON the remove-handler may need that can no
// longer be read from the deleted row (e.g. progress photos need the
// SERVER id because their delete endpoint keys on it, not the local id).
export async function enqueueDelete(entityType, localId, hadServerBackup, snapshot = null) {
  const db = await getDb();
  try {
    await db.runAsync(
      `DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND operation != 'DELETE'`,
      [entityType, String(localId)]
    );
    if (!hadServerBackup) return; // never synced — nothing to tell the server
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO sync_queue (operation_id, entity_type, entity_id, operation, payload,
         created_at, updated_at, status)
       VALUES (?, ?, ?, 'DELETE', ?, ?, ?, 'PENDING')`,
      [`${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, entityType, String(localId),
       snapshot ? JSON.stringify(snapshot) : null, now, now]
    );
  } catch (e) {
    console.error('[SYNC] enqueueDelete failed (local delete unaffected):', e.message);
  }
  kickQueue();
}

// Debounced auto-sync kick: any enqueue schedules one processQueue attempt
// a few seconds later. processQueue itself enforces mode/connectivity/
// single-flight, so the kick is always safe — in manual/local_only it
// simply no-ops. This closes the window where a freshly created item
// (e.g. a trainer's custom exercise) sat unsynced until a reconnect, the
// 10-minute timer, or an app restart — and was lost if the user cleared
// app data inside that window.
let kickTimer = null;
function kickQueue() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    processQueue().catch(() => {});
  }, 4000);
}


// ── payload builders (fresh from DB — the anti-zeroing guarantee) ───────
async function buildSessionPayload(sid) {
  const db = await getDb();
  // const s = await db.getFirstAsync('SELECT * FROM workout_sessions WHERE id = ?', [sid]);
    const s = await db.getFirstAsync(
    'SELECT * FROM workout_sessions WHERE id = ? AND user_id = ?',
    [sid, getCurrentUserId()]
  );
  if (!s) return null;
  const exs = await db.getAllAsync(
    `SELECT se.*, e.name AS exercise_name, e.muscle_group AS ex_muscle
     FROM session_exercises se JOIN exercises e ON e.id = se.exercise_id
     WHERE se.session_id = ? ORDER BY se.position`,
    [sid]
  );
  const exercises = [];
  for (let i = 0; i < exs.length; i++) {
    const ex = exs[i];
    const sets = await db.getAllAsync(
      'SELECT * FROM sets WHERE session_exercise_id = ? ORDER BY position',
      [ex.id]
    );
    exercises.push({
      local_entity_id: `${s.id}:e${i}`,
      exercise_name: ex.exercise_name,
      muscle_group: ex.muscle_group || ex.ex_muscle || null,
      order_index: ex.position,
      rest_seconds: ex.rest_seconds,
      group_id: ex.group_id,
          notes: ex.notes,
          trainerNote: ex.trainer_note || null, // personal backup only
      sets: sets.map((st, j) => ({
        local_entity_id: `${s.id}:e${i}:s${j}`,
        weight: st.weight,
        reps: st.reps,
        set_type: st.set_type,
        rpe: st.rpe,
        completed: st.completed !== 0,
        order_index: st.position,
      })),
    });
  }
  return {
    local_entity_id: String(s.id),
    name: s.name,
    started_at: new Date(s.start_time).toISOString(),
    finished_at: s.end_time ? new Date(s.end_time).toISOString() : null,
    duration_seconds: s.duration_sec,
    notes: s.notes,
    plan_local_id: s.plan_id != null ? String(s.plan_id) : null,
    source_assigned_plan_id: s.source_assigned_plan_id || null,
    exercises,
  };
}

async function buildPlanPayload(pid) {
  const db = await getDb();
  // const p = await db.getFirstAsync('SELECT * FROM workout_plans WHERE id = ?', [pid]);
    const p = await db.getFirstAsync(
    'SELECT * FROM workout_plans WHERE id = ? AND user_id = ?',
    [pid, getCurrentUserId()]
  );
  if (!p) return null;
  const exs = await db.getAllAsync(
    `SELECT pe.*, e.name AS exercise_name
     FROM plan_exercises pe JOIN exercises e ON e.id = pe.exercise_id
     WHERE pe.plan_id = ? ORDER BY pe.position`,
    [pid]
  );
  // configured swap alternatives ride along per exercise — without them a
  // backup restore loses the user's configured substitution options
  for (const ex of exs) {
    ex.alternatives = await db.getAllAsync(
      'SELECT alternative_exercise_name FROM plan_exercise_alternatives WHERE plan_exercise_id = ? ORDER BY order_index',
      [String(ex.id)]
    );
  }
  return {
    local_plan_id: String(p.id),
    name: p.name,
    notes: p.notes,
    tags: p.tags ? JSON.parse(p.tags) : [],
    exercises: exs.map((ex, i) => ({
      exercise_id: ex.exercise_id, // kept for compat with existing rows
      exercise_name: ex.exercise_name, // authoritative: restore resolves by name
      target_sets: ex.target_sets,
      rest_seconds: ex.rest_seconds,
      order_index: ex.position ?? i,
      group_id: ex.group_id,
      alternatives: (ex.alternatives || []).map((a) => a.alternative_exercise_name),
    })),
    created_at: p.created_at ? new Date(p.created_at).toISOString() : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function parseJsonArr(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function buildRecipePayload(localId) {
  const db = await getDb();
  // const r = await db.getFirstAsync('SELECT * FROM local_recipes WHERE local_id = ?', [localId]);
    const r = await db.getFirstAsync(
    'SELECT * FROM local_recipes WHERE local_id = ? AND user_id = ?',
    [localId, getCurrentUserId()]
  );
  if (!r) return null;
  return {
    local_entity_id: r.local_id,
    name: r.name, description: r.description, prep_notes: r.prep_notes,
    calories: r.calories, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g,
    serving_size: r.serving_size, recipe_url: r.recipe_url, photo_path: r.photo_path,
    ingredients: parseJsonArr(r.ingredients), allergens: parseJsonArr(r.allergens),
    prep_time_minutes: r.prep_time_minutes, cook_time_minutes: r.cook_time_minutes,
    difficulty: r.difficulty, suggested_meal_types: parseJsonArr(r.suggested_meal_types),
    is_favorite: r.is_favorite === 1,
    alternate_servings: parseJsonArr(r.alternate_servings), tags: parseJsonArr(r.tags),
  };
}

async function buildDietPlanPayload(localId) {
  const db = await getDb();
  // const p = await db.getFirstAsync('SELECT * FROM local_diet_plans WHERE local_id = ?', [localId]);
    const p = await db.getFirstAsync(
    'SELECT * FROM local_diet_plans WHERE local_id = ? AND user_id = ?',
    [localId, getCurrentUserId()]
  );
  if (!p) return null;
  const days = await db.getAllAsync(
    'SELECT * FROM local_diet_plan_days WHERE diet_plan_local_id = ? ORDER BY order_index', [localId]);
  for (const d of days) {
    d.meals = await db.getAllAsync(
      'SELECT * FROM local_diet_plan_meals WHERE diet_day_local_id = ? ORDER BY order_index', [d.local_id]);
    for (const m of d.meals) {
      m.items = await db.getAllAsync(
        'SELECT * FROM local_diet_plan_meal_items WHERE diet_meal_local_id = ? ORDER BY order_index', [m.local_id]);
      // configured dish alternatives travel INSIDE each item's payload
      for (const it of m.items) {
        it.alternatives = await db.getAllAsync(
          `SELECT * FROM local_diet_plan_meal_item_alternatives
           WHERE local_diet_plan_meal_item_id = ? ORDER BY order_index`, [it.local_id]);
      }
    }
  }
  return {
    local_entity_id: p.local_id, name: p.name, notes: p.notes, tags: parseJsonArr(p.tags),
    daily_calorie_target: p.daily_calorie_target, daily_protein_target: p.daily_protein_target,
    daily_carbs_target: p.daily_carbs_target, daily_fat_target: p.daily_fat_target,
    days: days.map((d) => ({
      local_entity_id: d.local_id, day_label: d.day_label, order_index: d.order_index,
      meals: d.meals.map((m) => ({
        local_entity_id: m.local_id, meal_type: m.meal_type, order_index: m.order_index, slot_note: m.slot_note,
        items: m.items.map((it) => ({
          local_entity_id: it.local_id, local_recipe_id: it.local_recipe_id || null,
          name: it.name, calories: it.calories, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g,
          serving_size: it.serving_size, recipe_url: it.recipe_url,
          quantity_multiplier: it.quantity_multiplier || 1, client_note: it.client_note,
          order_index: it.order_index, photo_path: it.photo_path,
          ingredients: parseJsonArr(it.ingredients), allergens: parseJsonArr(it.allergens),
          prep_time_minutes: it.prep_time_minutes, cook_time_minutes: it.cook_time_minutes,
          difficulty: it.difficulty, alternate_servings: parseJsonArr(it.alternate_servings),
          tags: parseJsonArr(it.tags),
          alternatives: (it.alternatives || []).map((a) => ({
            name: a.alternative_name, calories: a.alternative_calories,
            protein_g: a.alternative_protein_g, carbs_g: a.alternative_carbs_g,
            fat_g: a.alternative_fat_g, recipe_local_id: a.alternative_recipe_local_id || null,
          })),
        })),
      })),
    })),
  };
}

async function buildSupplementPlanPayload(localId) {
  const db = await getDb();
  // const p = await db.getFirstAsync('SELECT * FROM local_supplement_plans WHERE local_id = ?', [localId]);
    const p = await db.getFirstAsync(
    'SELECT * FROM local_supplement_plans WHERE local_id = ? AND user_id = ?',
    [localId, getCurrentUserId()]
  );
  if (!p) return null;
  const items = await db.getAllAsync(
    'SELECT * FROM local_supplement_plan_items WHERE supplement_plan_local_id = ? ORDER BY order_index', [localId]);
  return {
    local_entity_id: p.local_id, name: p.name, notes: p.notes, tags: parseJsonArr(p.tags),
    items: items.map((it) => ({
      local_entity_id: it.local_id, supplement_name: it.supplement_name,
      dosage: it.dosage, timing: it.timing, notes: it.notes, order_index: it.order_index,
    })),
  };
}

// ── handlers: upsert(localId) → builds payload fresh, pushes, marks synced
//             remove(localId) → idempotent server delete
//             deps(localId)  → local ids of unsynced parents blocking this row
const HANDLERS = {
  session: {
    path: '/user/backup/sessions',
    async upsert(id) {
      const payload = await buildSessionPayload(id);
      if (!payload) return; // deleted meanwhile — clean no-op
      const rows = await api(this.path, { method: 'POST', body: payload });
      const serverId = Array.isArray(rows) ? rows[0]?.id : rows?.id;
      const db = await getDb();
      await db.runAsync('UPDATE workout_sessions SET synced = 1, server_id = ? WHERE id = ?', [serverId || null, id]);
    },
    async remove(id) { await api(`${this.path}/${id}`, { method: 'DELETE' }); },
    deps: null,
  },
  workout_plan: {
    path: '/user/backup/workout-plans',
    async upsert(id) {
      const payload = await buildPlanPayload(id);
      if (!payload) return;
      const rows = await api(this.path, { method: 'POST', body: [payload] });
      const serverId = Array.isArray(rows) ? rows[0]?.id : rows?.id;
      const db = await getDb();
      await db.runAsync('UPDATE workout_plans SET synced = 1, server_id = ? WHERE id = ?', [serverId || null, id]);
    },
    async remove(id) { await api(`${this.path}/${id}`, { method: 'DELETE' }); },
    deps: null,
  },


  // },

    custom_exercise: {
    path: '/user/backup/custom-exercises',
    async upsert(id) {
      const db = await getDb();
      const userId = getCurrentUserId();
      const e = await db.getFirstAsync(
        'SELECT * FROM exercises WHERE id = ? AND is_custom = 1 AND (user_id IS NULL OR user_id = ?)',
        [id, userId]
      );
      // if (!e) {
      //   // owned by another account on this device — mark FAILED so it
      //   // retries automatically when THAT account logs in
      //   throw new Error('Exercise belongs to another account on this device');
      // }
            if (!e) return; // not found or owned by ANOTHER account on this device —
                      // skip cleanly: never back up another account's data, never fail
      const rows = await api(this.path, {
        method: 'POST',
        // body: [{ local_entity_id: String(e.id), name: e.name, muscle_group: e.muscle_group, instructions: e.instructions, thumbnail_path: e.thumbnail_path }],
                body: [{ local_entity_id: String(e.id), name: e.name, muscle_group: e.muscle_group,
                 instructions: e.instructions, thumbnail_path: e.thumbnail_path,
                 equipment: e.equipment ?? null, body_part: e.body_part ?? null }],
      });
      await db.runAsync('UPDATE exercises SET synced = 1, server_id = ? WHERE id = ?', [rows?.[0]?.id || null, id]);
    },
    async remove(id) { await api(`${this.path}/${id}`, { method: 'DELETE' }); },
    deps: null,
  },





  measurement: {
    // entity_id is "date|metric_type" (composite natural key)
    path: '/user/backup/measurements',
    async upsert(entityId) {
      const [date, metricType] = String(entityId).split('|');
      const db = await getDb();
      const m = await db.getFirstAsync(
        // 'SELECT * FROM body_metrics WHERE date = ? AND metric_type = ?', [date, metricType]);
        'SELECT * FROM body_metrics WHERE date = ? AND metric_type = ? AND user_id = ?',
        [date, metricType, getCurrentUserId()]);
      if (!m) return;
      await api(this.path, { method: 'POST', body: [{ date: m.date, metric_type: m.metric_type, value: m.value, unit: m.unit }] });
      await db.runAsync('UPDATE body_metrics SET synced = 1 WHERE date = ? AND metric_type = ?', [date, metricType]);
    },
    async remove(entityId) {
      const [date, metricType] = String(entityId).split('|');
      await api(`${this.path}/${date}/${metricType}`, { method: 'DELETE' });
    },
    deps: null,
  },
  recipe: {
    path: '/user/backup/recipes',
    async upsert(localId) {
      const payload = await buildRecipePayload(localId);
      if (!payload) return;
      const rows = await api(this.path, { method: 'POST', body: [payload] });
      const db = await getDb();
      await db.runAsync('UPDATE local_recipes SET synced = 1, server_id = ? WHERE local_id = ?', [rows?.[0]?.id || null, localId]);
    },
    async remove(localId) { await api(`${this.path}/${localId}`, { method: 'DELETE' }); },
    deps: null,
  },
  diet_plan: {
    path: '/user/backup/diet-plans',
    async upsert(localId) {
      const payload = await buildDietPlanPayload(localId);
      if (!payload) return;
      const row = await api(this.path, { method: 'POST', body: payload });
      const db = await getDb();
      await db.runAsync('UPDATE local_diet_plans SET synced = 1, server_id = ? WHERE local_id = ?', [row?.id || null, localId]);
    },
    async remove(localId) { await api(`${this.path}/${localId}`, { method: 'DELETE' }); },
    // blocked while any referenced recipe is still unsynced
    async deps(localId) {
      const db = await getDb();
      const rows = await db.getAllAsync(
        `SELECT DISTINCT it.local_recipe_id FROM local_diet_plan_meal_items it
         JOIN local_diet_plan_meals m ON m.local_id = it.diet_meal_local_id
         JOIN local_diet_plan_days d ON d.local_id = m.diet_day_local_id
         JOIN local_recipes r ON r.local_id = it.local_recipe_id
         WHERE d.diet_plan_local_id = ? AND r.synced = 0`, [localId]);
      return rows.map((x) => x.local_recipe_id);
    },
  },
  diet_checkin: {
    path: '/user/backup/diet-checkins',
    async upsert(entityId) {
      const [planLocalId, date] = String(entityId).split('|');
      const db = await getDb();

        const c = await db.getFirstAsync(
        'SELECT * FROM local_diet_checkins WHERE diet_plan_local_id = ? AND date = ? AND (user_id IS NULL OR user_id = ?)',
        [planLocalId, date, getCurrentUserId()]);
      // const c = await db.getFirstAsync(
      //   'SELECT * FROM local_diet_checkins WHERE diet_plan_local_id = ? AND date = ?', [planLocalId, date]);
      if (!c) return;
      await api(this.path, {
        method: 'POST',
        body: [{ diet_plan_local_id: c.diet_plan_local_id, date: c.date, followed: c.followed === 1, note: c.note }],
      });
      await db.runAsync('UPDATE local_diet_checkins SET synced = 1 WHERE id = ?', [c.id]);
    },
    async remove(entityId) {
      const [planLocalId, date] = String(entityId).split('|');
      // server check-ins are upserted; a deleted local check-in is re-marked
      // by the next upsert — nothing to hard-delete server-side
      await api(`${this.path}?plan_local_id=${encodeURIComponent(planLocalId)}`);
    },
    async deps(entityId) {
      const [planLocalId] = String(entityId).split('|');
      const db = await getDb();
      const p = await db.getFirstAsync('SELECT synced FROM local_diet_plans WHERE local_id = ?', [planLocalId]);
      return p && p.synced === 0 ? [planLocalId] : [];
    },
  },
  // diet_swap: "on DATE I ate X instead of Y" — date-scoped, unlike the
  // session-scoped workout swap. Entity id is "itemRef|date". Every swap is
  // privately backed up (self-authored AND trainer-assigned plans); the
  // server decides trainer visibility via plan_server_id.
  diet_swap: {
    path: '/user/backup/diet-swaps',
    async upsert(entityId) {
      const [itemRef, date] = String(entityId).split('|');
      const db = await getDb();
      const s = await db.getFirstAsync(
        'SELECT * FROM local_diet_item_swaps WHERE diet_plan_meal_item_ref = ? AND swap_date = ?',
        [itemRef, date]
      );
      if (!s) return;
      const rows = await api(this.path, {
        method: 'POST',
        body: [{
          plan_ref: s.plan_ref,
          plan_server_id: s.plan_ref && !/^(dp_|mig_)/.test(String(s.plan_ref)) ? s.plan_ref : null,
          diet_plan_meal_item_ref: s.diet_plan_meal_item_ref,
          swap_date: s.swap_date,
          original_name: s.original_name,
          swapped_name: s.swapped_name,
          swapped_calories: s.swapped_calories,
          swapped_protein_g: s.swapped_protein_g,
          swapped_carbs_g: s.swapped_carbs_g,
          swapped_fat_g: s.swapped_fat_g,
        }],
      });
      await db.runAsync(
        'UPDATE local_diet_item_swaps SET synced = 1, server_id = ? WHERE id = ?',
        [rows?.[0]?.id || null, s.id]
      );
    },
    async remove(entityId) {
      const [itemRef, date] = String(entityId).split('|');
      await api(`${this.path}/${encodeURIComponent(itemRef)}/${encodeURIComponent(date)}`, { method: 'DELETE' });
    },
    async deps(entityId) {
      const [itemRef] = String(entityId).split('|');
      const db = await getDb();
      const s = await db.getFirstAsync(
        'SELECT plan_ref FROM local_diet_item_swaps WHERE diet_plan_meal_item_ref = ?', [itemRef]);
      if (!s || !/^(dp_|mig_)/.test(String(s.plan_ref))) return []; // assigned plan — no local parent
      const p = await db.getFirstAsync('SELECT synced FROM local_diet_plans WHERE local_id = ?', [s.plan_ref]);
      return p && p.synced === 0 ? [s.plan_ref] : [];
    },
  },
  // diet_food_log: the raw food diary ("what I actually ate"). One row per
  // logged food; entity id is the entry's stable local id so repeated syncs
  // upsert idempotently server-side (UNIQUE(user_id, local_entity_id)) —
  // an offline entry synced twice can never become a duplicate. plan_ref
  // follows the diet_swap convention: local plan id for self-authored
  // plans, server uuid for assigned plans (plan_server_id drives the
  // trainer's monitoring visibility; self-authored logs stay private).
  diet_food_log: {
    path: '/user/backup/food-log',
    async upsert(localId) {
      const db = await getDb();
      const e = await db.getFirstAsync(
        'SELECT * FROM local_food_log_entries WHERE local_id = ? AND (user_id IS NULL OR user_id = ?)',
        [localId, getCurrentUserId()]
      );
      if (!e) return; // deleted meanwhile — clean no-op
      const rows = await api(this.path, {
        method: 'POST',
        body: [{
          local_entity_id: e.local_id,
          plan_ref: e.plan_ref || null,
          plan_server_id: e.plan_ref && !/^(dp_|mig_)/.test(String(e.plan_ref)) ? e.plan_ref : null,
          plan_version_id: e.plan_version_id ?? null,
          log_date: e.log_date,
          meal_type: e.meal_type ?? null,
          source: e.source,
          planned_item_ref: e.planned_item_ref ?? null,
          name: e.name,
          calories: e.calories,
          protein_g: e.protein_g,
          carbs_g: e.carbs_g,
          fat_g: e.fat_g,
          serving_size: e.serving_size ?? null,
          quantity: e.quantity || 1,
          logged_at: new Date(e.logged_at || Date.now()).toISOString(),
        }],
      });
      await db.runAsync(
        'UPDATE local_food_log_entries SET synced = 1, server_id = ? WHERE local_id = ?',
        [rows?.[0]?.id || null, localId]
      );
    },
    async remove(localId) {
      await api(`${this.path}/${encodeURIComponent(localId)}`, { method: 'DELETE' });
    },
    async deps(localId) {
      const db = await getDb();
      const e = await db.getFirstAsync('SELECT plan_ref FROM local_food_log_entries WHERE local_id = ?', [localId]);
      if (!e || !e.plan_ref || !/^(dp_|mig_)/.test(String(e.plan_ref))) return []; // assigned plan — no local parent
      const p = await db.getFirstAsync('SELECT synced FROM local_diet_plans WHERE local_id = ?', [e.plan_ref]);
      return p && p.synced === 0 ? [e.plan_ref] : [];
    },
  },

  // food_log: the LOG-FIRST diary (migration v39) — user-scoped entries,
  // no plan container. Stable local ids + server upserts keyed
  // (user_id, local_entity_id) keep repeated offline syncs idempotent.
  food_log: {
    path: '/user/backup/food-log-entries',
    async upsert(localId) {
      const db = await getDb();
      const e = await db.getFirstAsync(
        'SELECT * FROM food_log_entries WHERE local_id = ? AND (user_id IS NULL OR user_id = ?)',
        [localId, getCurrentUserId()]
      );
      if (!e) return;
      const rows = await api(this.path, {
        method: 'POST',
        body: [{
          local_entity_id: e.local_id,
          log_date: e.log_date,
          meal_type: e.meal_type,
          name: e.name,
          calories: e.calories,
          protein_g: e.protein_g,
          carbs_g: e.carbs_g,
          fat_g: e.fat_g,
          fiber_g: e.fiber_g,
          sugar_g: e.sugar_g,
          sodium_mg: e.sodium_mg,
          quantity: e.quantity || 1,
          serving_unit: e.serving_unit || 'serving',
          food_source_type: e.food_source_type || 'manual',
          food_source_id: e.food_source_id ?? null,
          suggested_by_trainer: e.suggested_by_trainer === 1,
          logged_at: new Date(e.logged_at || Date.now()).toISOString(),
        }],
      });
      await db.runAsync(
        'UPDATE food_log_entries SET synced = 1, server_id = ? WHERE local_id = ?',
        [rows?.[0]?.id || null, localId]
      );
    },
    async remove(localId) {
      await api(`${this.path}/${encodeURIComponent(localId)}`, { method: 'DELETE' });
    },
    deps: null,
  },

  // custom_dish: the ingredient-based dish builder (snapshot macros inside
  // each ingredient row). Ingredients ride INSIDE the dish payload.
  custom_dish: {
    path: '/user/backup/custom-dishes',
    async upsert(localId) {
      const db = await getDb();
      const d = await db.getFirstAsync(
        'SELECT * FROM custom_dishes WHERE local_id = ? AND (user_id IS NULL OR user_id = ?)',
        [localId, getCurrentUserId()]
      );
      if (!d) return;
      const ings = await db.getAllAsync(
        'SELECT * FROM custom_dish_ingredients WHERE custom_dish_local_id = ? ORDER BY order_index',
        [localId]
      );
      const rows = await api(this.path, {
        method: 'POST',
        body: {
          local_entity_id: d.local_id,
          name: d.name,
          total_servings: d.total_servings || 1,
          ingredients: ings.map((i) => ({
            global_food_id: i.global_food_id || null,
            ingredient_name: i.ingredient_name,
            quantity: i.quantity,
            unit: i.unit,
            calories_snapshot: i.calories_snapshot,
            protein_g_snapshot: i.protein_g_snapshot,
            carbs_g_snapshot: i.carbs_g_snapshot,
            fat_g_snapshot: i.fat_g_snapshot,
          })),
        },
      });
      await db.runAsync(
        'UPDATE custom_dishes SET synced = 1, server_id = ? WHERE local_id = ?',
        [rows?.[0]?.id || null, localId]
      );
    },
    async remove(localId) {
      await api(`${this.path}/${encodeURIComponent(localId)}`, { method: 'DELETE' });
    },
    deps: null,
  },

  supplement_plan: {
    path: '/user/backup/supplement-plans',
    async upsert(localId) {
      const payload = await buildSupplementPlanPayload(localId);
      if (!payload) return;
      const row = await api(this.path, { method: 'POST', body: payload });
      const db = await getDb();
      await db.runAsync('UPDATE local_supplement_plans SET synced = 1, server_id = ? WHERE local_id = ?', [row?.id || null, localId]);
    },
    async remove(localId) { await api(`${this.path}/${localId}`, { method: 'DELETE' }); },
    deps: null,
  },
  supplement_checkin: {
    path: '/user/backup/supplement-checkins',
    async upsert(entityId) {
      const [planLocalId, date] = String(entityId).split('|');
      const db = await getDb();
      // const c = await db.getFirstAsync(
      //   'SELECT * FROM local_supplement_checkins WHERE supplement_plan_local_id = ? AND date = ?', [planLocalId, date]);
        const c = await db.getFirstAsync(
        'SELECT * FROM local_supplement_checkins WHERE supplement_plan_local_id = ? AND date = ? AND (user_id IS NULL OR user_id = ?)',
        [planLocalId, date, getCurrentUserId()]);

      if (!c) return;
      await api(this.path, {
        method: 'POST',
        body: [{ supplement_plan_local_id: c.supplement_plan_local_id, date: c.date, taken: c.taken === 1, note: c.note }],
      });
      await db.runAsync('UPDATE local_supplement_checkins SET synced = 1 WHERE id = ?', [c.id]);
    },
    async remove(entityId) {
      const [planLocalId] = String(entityId).split('|');
      await api(`${this.path}?plan_local_id=${encodeURIComponent(planLocalId)}`);
    },
    async deps(entityId) {
      const [planLocalId] = String(entityId).split('|');
      const db = await getDb();
      const p = await db.getFirstAsync('SELECT synced FROM local_supplement_plans WHERE local_id = ?', [planLocalId]);
      return p && p.synced === 0 ? [planLocalId] : [];
    },
  },



  personal_record: {
    path: '/user/backup/personal-records',
    async upsert(id) {
      const db = await getDb();
      let r = await db.getFirstAsync('SELECT * FROM personal_records WHERE id = ?', [id]);
      if (!r) return;
      // resolve the exercise name fresh — PR rows created before the v23
      // upgrade may carry a NULL exercise_name
      if (!r.exercise_name) {
        const ex = await db.getFirstAsync('SELECT name FROM exercises WHERE id = ?', [r.exercise_id]);
        if (!ex) return; // source exercise no longer exists — nothing to back up
        r = { ...r, exercise_name: ex.name };
      }
      const rows = await api(this.path, {
        method: 'POST',
        body: [{
          local_entity_id: String(r.id), exercise_name: r.exercise_name,
          record_type: r.record_type, value: r.value,
          secondary_value: r.secondary_value,
          achieved_at: r.achieved_at,
        }],
      });
      await db.runAsync('UPDATE personal_records SET synced = 1, server_id = ? WHERE id = ?', [rows?.[0]?.id || null, id]);
    },
    async remove(id) { await api(`${this.path}/${id}`, { method: 'DELETE' }); },
    deps: null,
  },




  // progress_photo: {
  //   path: '/user/backup/progress-photos',
  //   async upsert(id) {
  //     const db = await getDb();
  //     const p = await db.getFirstAsync('SELECT * FROM progress_photos WHERE id = ?', [id]);
  //     if (!p) return;
  //   //   const base64 = await FileSystem.readAsStringAsync(p.file_path, {
  //   //     encoding: FileSystem.EncodingType.Base64,
  //   //   });


    // progress photos → the FIRST-CLASS /progress-photos API (not the old
  // backup route). Upsert = create-or-replace BY DATE (LWW — the server's
  // documented conflict policy), carrying the current bytes + visibility.
  // DELETE by server id (photos always carry server_id once synced — the
  // old local-id delete is retired along with the backup route).
  progress_photo: {
    path: '/progress-photos',
    async upsert(id) {
      const db = await getDb();
      // const p = await db.getFirstAsync('SELECT * FROM progress_photos WHERE id = ?', [id]);
        const p = await db.getFirstAsync(
        'SELECT * FROM progress_photos WHERE id = ? AND (user_id IS NULL OR user_id = ?)',
        [id, getCurrentUserId()]);
      if (!p) return; // deleted meanwhile — clean no-op
      const body = {
        // photo_date: p.date,
        photo_date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.date)) ? p.date : new Date(p.date).toISOString().slice(0, 10),
        visibility: p.visibility || 'PERSONAL',
      };
      // local capture → upload the bytes; server-fetched row (image_path,
      // no local file) → metadata-only visibility change via PATCH
      if (p.file_path) {
        const filePath = String(p.file_path).startsWith('file:')
          ? p.file_path
          : `${FileSystem.documentDirectory}progress_photos/${p.file_path}`;
        body.image_base64 = await FileSystem.readAsStringAsync(filePath, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const row = await api(this.path, { method: 'POST', body });
        await db.runAsync(
          'UPDATE progress_photos SET synced = 1, server_id = ?, image_path = ? WHERE id = ?',
          [row?.id || null, row?.image_path || null, id]);
      } else if (
  p.server_id &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(p.server_id)
  )
) {
  // genuine first-class UUID → metadata-only visibility update
  await api(`${this.path}/${p.server_id}`, {
    method: 'PATCH',
    body: { visibility: p.visibility || 'PERSONAL' },
  });

  await db.runAsync(
    'UPDATE progress_photos SET synced = 1 WHERE id = ?',
    [id]
  );

} else if (p.server_id) {
  // STALE server_id (numeric — written by the retired backup system).
  // No local file exists, so a full POST is impossible. Instead adopt
  // the server's real photo for this DATE.
  const list = await api(this.path).catch(() => []);

  const match = (list || []).find(
    (x) => String(x.photo_date) === String(p.date)
  );

  if (match) {
    await db.runAsync(
      'UPDATE progress_photos SET synced = 1, server_id = ?, image_path = ? WHERE id = ?',
      [match.id, match.image_path || null, id]
    );
  } else {
    // No server photo for this date either.
    // This local row is display-only, so stop retrying it.
    await db.runAsync(
      'UPDATE progress_photos SET synced = 1 WHERE id = ?',
      [id]
    );
  }

} else {
  // no file_path, no server_id: nothing pushable — display-only
  await db.runAsync(
    'UPDATE progress_photos SET synced = 1 WHERE id = ?',
    [id]
  );
}
    },
    async remove(id) {
      const db = await getDb();
      // enqueueDelete captured hadServerBackup before the row vanished, but
      // the row is gone by process time — the server delete keys on the
      // SERVER id, which we must recover. Look it up by entity id in the
      // (just-deleted) local table returns nothing, so delete-by-date LWW
      // replacement covers the row; for true deletes we rely on the queue
      // carrying the id: extract from the queue row's entity_id → the id
      // IS the local id. Server-side delete needs the server id, which we
      // stash in the queue via a pre-delete snapshot:
      const snap = await db.getFirstAsync(
        'SELECT payload FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND operation = ?',
        ['progress_photo', String(id), 'DELETE']
      );
      let serverId = null;
      try { serverId = snap?.payload ? JSON.parse(snap.payload).server_id : null; } catch {}
      if (serverId) {
        await api(`${this.path}/${serverId}`, { method: 'DELETE' });
      }
      // no snapshot (never synced) — clean local removal, nothing to do
    },
    deps: null,
  },
};

// ── the processor ────────────────────────────────────────────────────────
export async function processQueue({ manual = false } = {}) {
  const settings = await getSyncSettings();
  if (settings.sync_mode === 'local') return { skipped: true, reason: 'local_only' };
  if (settings.sync_mode === 'manual' && !manual) return { skipped: true, reason: 'manual_mode' };
//   if (!connectivity.isConnected) return { skipped: true, reason: 'offline' };
  if (!getCurrentUserId()) return { skipped: true, reason: 'not_authenticated' };
  // refresh connectivity live — the engine's own listener doesn't start
  // until Part D, so never trust a stale cached state
  try {
    const state = await NetInfo.fetch();
    connectivity = {
      isConnected: !!(state.isConnected && state.isInternetReachable !== false),
      isInternetReachable: state.isInternetReachable !== false,
    };
  } catch {}
  if (!connectivity.isConnected) return { skipped: true, reason: 'offline' };
  if (processing) return { skipped: true, reason: 'in_progress' };

  processing = true;
  let uploaded = 0;
  let failed = 0;
  let deferred = 0;
  const errors = [];

  try {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM sync_queue WHERE status IN ('PENDING','FAILED') ORDER BY created_at ASC LIMIT ?`,
      [BATCH_LIMIT]
    );
    const now = Date.now();

    for (const op of rows) {
      if (!connectivity.isConnected) break;

      // permanent failures stop auto-retrying (manual trigger overrides)
      if (op.status === 'FAILED' && !manual) {
        if ((op.retry_count || 0) >= MAX_ATTEMPTS) { failed++; continue; }
        const wait = BACKOFF_MS[Math.min((op.retry_count || 1) - 1, BACKOFF_MS.length - 1)] || BACKOFF_MS[0];
        if (op.last_attempt_at && now - op.last_attempt_at < wait) { deferred++; continue; }
      }

      const handler = HANDLERS[op.entity_type];
      if (!handler) {
        await db.runAsync(
          `UPDATE sync_queue SET status = 'FAILED', retry_count = 5, last_error = 'unknown entity type', last_attempt_at = ? WHERE id = ?`,
          [now, op.id]
        );
        failed++;
        continue;
      }

      // dependency check against LOCAL state (authoritative)
      if (handler.deps) {
        const blockers = await handler.deps(op.entity_id);
        if (blockers && blockers.length) { deferred++; continue; }
      }

      await db.runAsync(
        `UPDATE sync_queue SET status = 'SYNCING', last_attempt_at = ? WHERE id = ?`, [now, op.id]);

      try {
        if (op.operation === 'DELETE') {
          await handler.remove(op.entity_id);
        } else {
          await handler.upsert(op.entity_id);
        }
        await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [op.id]); // done — clean up
        uploaded++;
      } catch (e) {
        const attempts = (op.retry_count || 0) + 1;
        await db.runAsync(
          `UPDATE sync_queue SET status = 'FAILED', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?`,
          [attempts, String(e.message || e).slice(0, 300), now, op.id]
        );
        failed++;
        errors.push({ entity: `${op.entity_type}:${op.entity_id}`, error: e.message });
      }
    }

    if (uploaded > 0) await touchLastSynced();
    reportHealthToAdmin(failed > 0);
    return { uploaded, failed, deferred, errors };
  } finally {
    processing = false;
  }
}


// Failed-item detail for the settings UI: which entity, which local id,
// how many attempts, and the last recorded error. readAgo makes the
// backoff wait human-readable ("retry in ~2m").
export async function getFailedItems() {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT entity_type, entity_id, operation, retry_count, last_error, last_attempt_at
     FROM sync_queue WHERE status = 'FAILED'
     ORDER BY last_attempt_at DESC LIMIT 50`
  );
  const now = Date.now();
  const WAIT_LABELS = ['30s', '2m', '10m', '1h'];
  return rows.map((r) => {
    const attempts = r.retry_count || 0;
    const capped = attempts >= MAX_ATTEMPTS;
    const waited = r.last_attempt_at ? now - r.last_attempt_at : Infinity;
    // next retry is due when the current backoff window has elapsed
    const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
    const remaining = Math.max(0, BACKOFF_MS[idx] - waited);
    return {
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      operation: r.operation,
      attempts,
      capped,
      error: r.last_error || 'Unknown error',
      retry_in: capped ? null : remaining > 60000 ? `${Math.ceil(remaining / 60000)}m` : `${Math.ceil(remaining / 1000)}s`,
    };
  });
}

// ── engine status (drives the Settings UI in Phase 5) ───────────────────
export async function getEngineStatus() {
  const db = await getDb();
  const pending = await db.getFirstAsync(`SELECT COUNT(*) AS c FROM sync_queue WHERE status IN ('PENDING','SYNCING')`);
  const failed = await db.getFirstAsync(`SELECT COUNT(*) AS c FROM sync_queue WHERE status = 'FAILED'`);
  const settings = await getSyncSettings();
  return {
    sync_mode: settings.sync_mode,
    last_synced_at: settings.last_synced_at || null,
    pending_count: pending?.c || 0,
    failed_count: failed?.c || 0,
    isConnected: connectivity.isConnected,
  };
}


// Rebuild the queue for the account that just logged in. The queue is
// DERIVED state — durable truth lives in each table's synced/server_id
// flags — so every non-DELETE row is wiped and re-derived from ONLY the
// current user's unsynced data. The queue therefore never carries another
// account's items. DELETE rows are kept: they're user-scoped server-side
// (a foreign delete safely no-ops) and can't be re-derived locally.
export async function resyncQueueForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId || processing) return;
  const db = await getDb();
  await db.runAsync(`DELETE FROM sync_queue WHERE operation != 'DELETE'`);

  const enqueueAll = async (rows, entityType, toId) => {
    for (const r of rows) await enqueueUpsert(entityType, toId(r));
  };

  await enqueueAll(
    await db.getAllAsync('SELECT id FROM workout_sessions WHERE synced = 0 AND user_id = ?', [userId]),
    'session', (r) => String(r.id));
  await enqueueAll(
    await db.getAllAsync('SELECT id FROM workout_plans WHERE synced = 0 AND user_id = ?', [userId]),
    'workout_plan', (r) => String(r.id));
  await enqueueAll(
    await db.getAllAsync(
      'SELECT id FROM exercises WHERE is_custom = 1 AND synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'custom_exercise', (r) => String(r.id));
  await enqueueAll(
    await db.getAllAsync(
      'SELECT date, metric_type FROM body_metrics WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'measurement', (r) => `${r.date}|${r.metric_type}`);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM local_recipes WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'recipe', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM local_diet_plans WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'diet_plan', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM local_food_log_entries WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'diet_food_log', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM food_log_entries WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'food_log', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM custom_dishes WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'custom_dish', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT diet_plan_local_id, date FROM local_diet_checkins WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'diet_checkin', (r) => `${r.diet_plan_local_id}|${r.date}`);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT local_id FROM local_supplement_plans WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'supplement_plan', (r) => r.local_id);
  await enqueueAll(
    await db.getAllAsync(
      'SELECT supplement_plan_local_id, date FROM local_supplement_checkins WHERE synced = 0 AND (user_id = ? OR user_id IS NULL)', [userId]),
    'supplement_checkin', (r) => `${r.supplement_plan_local_id}|${r.date}`);
  // PRs and photos are device-level (not user-scoped by design) — they
  // back up to the signed-in account
  await enqueueAll(
    await db.getAllAsync('SELECT id FROM personal_records WHERE synced = 0'),
    'personal_record', (r) => String(r.id));
  await enqueueAll(
    await db.getAllAsync('SELECT id FROM progress_photos WHERE synced = 0'),
    'progress_photo', (r) => String(r.id));
}


// ── initialization (App.js calls this once after auth — Part D) ─────────
export function initSyncEngine() {
  if (launched) return;
  launched = true;

  (async () => {
    // crash recovery: a row left in SYNCING means the app died mid-flight
    const db = await getDb();
    await db.runAsync(`UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING'`);

    const check = async () => {
      try {
        const state = await NetInfo.fetch();
        const wasOffline = !connectivity.isConnected;
        connectivity = {
          isConnected: !!(state.isConnected && state.isInternetReachable !== false),
          isInternetReachable: state.isInternetReachable !== false,
        };
        if (wasOffline && connectivity.isConnected) {
          await processQueue(); // auto mode only — processQueue checks the mode
        }
      } catch {}
    };
    await check();
    NetInfo.addEventListener(check);

    // 10-minute safety net while the app is open (auto mode only)
    timer = setInterval(() => { processQueue(); }, 10 * 60 * 1000);
  })();
}

export function _resetForTests() {
  launched = false;
  if (timer) clearInterval(timer);
  timer = null;
}