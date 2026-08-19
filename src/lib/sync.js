// Offline-first sync service
import NetInfo from '@react-native-community/netinfo';
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { api } from './api';

const SYNC_STATUS = {
  SYNCED: 'SYNCED',
  PENDING_CREATE: 'PENDING_CREATE',
  PENDING_UPDATE: 'PENDING_UPDATE',
  PENDING_DELETE: 'PENDING_DELETE',
  SYNCING: 'SYNCING',
  FAILED: 'FAILED',
  CONFLICT: 'CONFLICT',
};

const ENTITY_TYPES = {
  SESSION: 'session',
  SESSION_DETAIL: 'session_detail',
  MEASUREMENT: 'measurement',
  WORKOUT_PLAN: 'workout_plan',
  EXERCISE: 'exercise',
  USER_SETTINGS: 'user_settings',
};

let connectivityState = { isConnected: false, isInternetReachable: false };
let syncInProgress = false;
let syncListeners = [];

export function addSyncListener(callback) {
  syncListeners.push(callback);
  return () => {
    syncListeners = syncListeners.filter(l => l !== callback);
  };
}

function notifyListeners(status) {
  syncListeners.forEach(l => l(status));
}

export async function getConnectivityState() {
  return connectivityState;
}

export async function initConnectivityListener() {
  const checkConnection = async () => {
    try {
      const state = await NetInfo.fetch();
      const wasOffline = !connectivityState.isConnected;
      connectivityState = {
        isConnected: !!(state.isConnected && state.isInternetReachable !== false),
        isInternetReachable: state.isInternetReachable !== false,
      };
      
      console.log('[SYNC] Connectivity changed:', connectivityState);
      notifyListeners({ type: 'CONNECTIVITY', ...connectivityState });
      
      // Auto-sync when coming online if in auto mode
      if (wasOffline && connectivityState.isConnected) {
        const settings = await getSyncSettings();
        if (settings.sync_mode === 'auto') {
          await syncPending();
        }
      }
    } catch (e) {
      console.error('[SYNC] Connectivity check failed:', e.message);
    }
  };
  
  // Initial check
  await checkConnection();
  
  // Listen for changes
  NetInfo.addEventListener(checkConnection);
  
  return checkConnection;
}

// Sync Settings
export async function getSyncSettings() {
  const db = await getDb();
  const row = await db.getFirstAsync('SELECT * FROM sync_settings WHERE id = 1');
  return row || { sync_mode: 'auto', sync_enabled: 1, last_synced_at: null };
}

export async function setSyncMode(mode) {
  const db = await getDb();
  await db.runAsync('UPDATE sync_settings SET sync_mode = ? WHERE id = 1', [mode]);
  notifyListeners({ type: 'SETTINGS_CHANGED', sync_mode: mode });
}

export async function updateLastSyncedAt(timestamp) {
  const db = await getDb();
  await db.runAsync('UPDATE sync_settings SET last_synced_at = ? WHERE id = 1', [timestamp]);
}

// Sync Queue Operations
function generateOperationId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export async function addToSyncQueue(entityType, entityId, operation, payload = null) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  
  const operationId = generateOperationId();
  const now = Date.now();
  
  // Check if there's already a pending operation for this entity
  const existing = await db.getFirstAsync(
    `SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING', 'SYNCING')`,
    [entityType, entityId]
  );
  
  if (existing) {
    // Update existing operation instead of creating duplicate
    await db.runAsync(
      `UPDATE sync_queue SET operation = ?, payload = ?, updated_at = ?, status = 'PENDING', last_error = NULL
       WHERE id = ?`,
      [operation, payload ? JSON.stringify(payload) : null, now, existing.id]
    );
    console.log('[SYNC] Updated existing queue operation:', entityType, entityId);
    return existing.operation_id;
  }
  
  await db.runAsync(
    `INSERT INTO sync_queue (operation_id, entity_type, entity_id, operation, payload, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [operationId, entityType, entityId, operation, payload ? JSON.stringify(payload) : null, now, now]
  );
  
  console.log('[SYNC] Added to queue:', operationId, entityType, entityId, operation);
  notifyListeners({ type: 'QUEUE_CHANGED' });
  return operationId;
}

export async function getPendingSyncCount() {
  const db = await getDb();
  const result = await db.getFirstAsync(
    "SELECT COUNT(*) as c FROM sync_queue WHERE status IN ('PENDING', 'SYNCING')"
  );
  return result?.c || 0;
}

export async function getSyncStatus() {
  const db = await getDb();
  const settings = await getSyncSettings();
  const pending = await getPendingSyncCount();
  
  let status = 'synced';
  if (!connectivityState.isConnected) {
    status = pending > 0 ? 'offline-pending' : 'offline';
  } else if (syncInProgress) {
    status = 'syncing';
  } else if (pending > 0) {
    status = 'pending';
  }
  
  return {
    status,
    sync_mode: settings.sync_mode,
    last_synced_at: settings.last_synced_at,
    pending_count: pending,
    isConnected: connectivityState.isConnected,
  };
}

async function markOperationStatus(operationId, status, error = null) {
  const db = await getDb();
  const now = Date.now();
  const retryCount = status === 'FAILED' ? 
    (await db.getFirstAsync('SELECT retry_count FROM sync_queue WHERE operation_id = ?', [operationId]))?.retry_count + 1 || 1 : 0;
  
  await db.runAsync(
    `UPDATE sync_queue SET status = ?, updated_at = ?, last_error = ?, retry_count = ? WHERE operation_id = ?`,
    [status, now, error, retryCount, operationId]
  );
}

async function removeCompletedOperations() {
  const db = await getDb();
  await db.runAsync("DELETE FROM sync_queue WHERE status = 'COMPLETED'");
}

// Main Sync Function
export async function syncPending() {
  const settings = await getSyncSettings();
  
  // Don't sync if in local-only mode
  if (settings.sync_mode === 'local') {
    console.log('[SYNC] Skipping - Local Only mode');
    return { skipped: true, reason: 'local_only' };
  }
  
  // Don't sync if not connected
  if (!connectivityState.isConnected) {
    console.log('[SYNC] Skipping - Not connected');
    return { skipped: true, reason: 'offline' };
  }
  
  if (syncInProgress) {
    console.log('[SYNC] Already in progress');
    return { skipped: true, reason: 'in_progress' };
  }
  
  syncInProgress = true;
  notifyListeners({ type: 'SYNC_START' });
  
  let uploaded = 0;
  let failed = 0;
  let errors = [];
  
  try {
    const db = await getDb();
    const operations = await db.getAllAsync(
      "SELECT * FROM sync_queue WHERE status IN ('PENDING', 'FAILED') ORDER BY created_at ASC LIMIT 50"
    );
    
    console.log('[SYNC] Processing', operations.length, 'operations');
    
    for (const op of operations) {
      if (!connectivityState.isConnected) {
        console.log('[SYNC] Lost connectivity, stopping');
        break;
      }
      
      await markOperationStatus(op.operation_id, 'SYNCING');
      
      try {
        await processOperation(op);
        await markOperationStatus(op.operation_id, 'COMPLETED');
        uploaded++;
        console.log('[SYNC] Completed:', op.operation_id);
      } catch (e) {
        await markOperationStatus(op.operation_id, 'FAILED', e.message);
        failed++;
        errors.push({ operation: op.operation_id, error: e.message });
        console.error('[SYNC] Failed:', op.operation_id, e.message);
      }
    }
    
    // Clean up completed operations
    await removeCompletedOperations();
    
    // Update last synced timestamp
    await updateLastSyncedAt(Date.now());
    
    const result = {
      uploaded,
      failed,
      errors,
      pending: await getPendingSyncCount(),
    };
    
    console.log('[SYNC] Completed:', result);
    notifyListeners({ type: 'SYNC_COMPLETE', ...result });
    
    return result;
  } catch (e) {
    console.error('[SYNC] Error:', e.message);
    notifyListeners({ type: 'SYNC_ERROR', error: e.message });
    throw e;
  } finally {
    syncInProgress = false;
  }
}

async function processOperation(op) {
  const payload = op.payload ? JSON.parse(op.payload) : null;
  
  switch (op.entity_type) {
    case ENTITY_TYPES.SESSION:
      return await syncSession(op.operation, op.entity_id, payload);
    case ENTITY_TYPES.MEASUREMENT:
      return await syncMeasurement(op.operation, op.entity_id, payload);
    case ENTITY_TYPES.WORKOUT_PLAN:
      return await syncWorkoutPlan(op.operation, op.entity_id, payload);
    default:
      console.warn('[SYNC] Unknown entity type:', op.entity_type);
  }
}

async function syncSession(operation, entityId, payload) {
  const endpoint = '/client/session-summaries';
  const method = operation === 'DELETE' ? 'DELETE' : 'POST';
  
  // For now, re-use existing sync logic
  // In a full implementation, we'd handle all CRUD operations
  console.log('[SYNC] Session operation:', operation, entityId);
  
  // The existing queueSessionForSync handles CREATE
  // For UPDATE/DELETE, we'd need additional endpoints
  if (operation === 'CREATE' && payload) {
    const summaries = [payload];
    await api(endpoint, { method: 'POST', body: summaries });
  }
}

async function syncMeasurement(operation, entityId, payload) {
  console.log('[SYNC] Measurement operation:', operation, entityId);
  if (operation === 'CREATE' && payload) {
    await api('/client/measurements', { method: 'POST', body: payload });
  }
}

async function syncWorkoutPlan(operation, entityId, payload) {
  console.log('[SYNC] Workout plan operation:', operation, entityId);
  
  if (operation === 'CREATE' || operation === 'UPDATE') {
    await api('/client/workout-templates', { method: 'POST', body: [payload] });
  } else if (operation === 'DELETE') {
    await api(`/client/workout-templates/${entityId}`, { method: 'DELETE' });
  }
}

// Cloud to Local Sync (for initial login or restore)
export async function pullFromCloud() {
  const settings = await getSyncSettings();
  
  if (settings.sync_mode === 'local') {
    return { skipped: true, reason: 'local_only' };
  }
  
  if (!connectivityState.isConnected) {
    return { skipped: true, reason: 'offline' };
  }
  
  const userId = getCurrentUserId();
  if (!userId) return { skipped: true, reason: 'not_authenticated' };
  
  let downloaded = 0;
  
  try {
    // Use the unified sync/pull endpoint
    const data = await api('/client/sync/pull', { skipAuth: false });
    const db = await getDb();
    
    // Pull sessions with full details
    if (data.sessions?.length) {
      for (const session of data.sessions) {
        // First, insert/update the session
        await db.runAsync(
          `INSERT OR REPLACE INTO workout_sessions 
           (name, start_time, end_time, duration_sec, notes, plan_id, synced, sync_attempted_at, source_assigned_plan_id, user_id)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            session.name, 
            new Date(session.performed_at).getTime(), 
            null, 
            session.duration_seconds,
            session.notes || null,
            session.plan_id || null,
            new Date().toISOString(), 
            session.source_assigned_plan_id || null, 
            userId
          ]
        );
        
        // Get the local session id
        const localSession = await db.getFirstAsync(
          'SELECT id FROM workout_sessions WHERE start_time = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
          [new Date(session.performed_at).getTime(), userId]
        );
        
        // Insert session details if available
        if (localSession && data.session_details && data.session_details[session.local_session_id]) {
          const details = data.session_details[session.local_session_id];
          for (let i = 0; i < details.length; i++) {
            const ex = details[i];
            // Find exercise id by name or create placeholder
            let exerciseId = null;
            const exerciseRow = await db.getFirstAsync(
              'SELECT id FROM exercises WHERE name = ?',
              [ex.exercise_name]
            );
            exerciseId = exerciseRow?.id || 1; // Fallback to first exercise
            
            const seResult = await db.runAsync(
              `INSERT INTO session_exercises (session_id, exercise_id, position, rest_seconds, muscle_group, notes)
               VALUES (?, ?, ?, 90, ?, null)`,
              [localSession.id, exerciseId, i, ex.muscle_group || null]
            );
            
            // Insert sets for this exercise
            if (ex.sets && Array.isArray(ex.sets)) {
              for (let j = 0; j < ex.sets.length; j++) {
                const set = ex.sets[j];
                await db.runAsync(
                  `INSERT INTO sets (session_exercise_id, weight, reps, is_warmup, position, set_type, completed)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [
                    seResult.lastInsertRowId,
                    set.weight || 0,
                    set.reps || 0,
                    set.set_type === 'warmup' ? 1 : 0,
                    j,
                    set.set_type || 'working',
                    set.completed !== false ? 1 : 0
                  ]
                );
              }
            }
          }
        }
        
        downloaded++;
      }
    }
    
    // Pull workout templates/plans with full exercise details
    if (data.workout_templates?.length) {
      for (const plan of data.workout_templates) {
        // Create a unique local ID based on the local_plan_id or generate one
        const localId = parseInt(plan.local_plan_id) || Date.now();
        
        await db.runAsync(
          `INSERT OR REPLACE INTO workout_plans (id, name, notes, created_at, user_id, tags)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            localId,
            plan.name, 
            plan.notes || null, 
            new Date(plan.created_at).getTime(), 
            userId,
            JSON.stringify(plan.tags || [])
          ]
        );
        
        // Insert exercises for the plan
        if (plan.exercises && Array.isArray(plan.exercises)) {
          await db.runAsync('DELETE FROM plan_exercises WHERE plan_id = ?', [localId]);
          for (let i = 0; i < plan.exercises.length; i++) {
            const ex = plan.exercises[i];
            await db.runAsync(
              `INSERT INTO plan_exercises (plan_id, exercise_id, position, target_sets, rest_seconds, group_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [localId, ex.exercise_id || ex.exerciseId, i, ex.target_sets || ex.targetSets || 3, ex.rest_seconds || ex.restSeconds || 90, ex.group_id || ex.groupId || null]
            );
          }
        }
        
        downloaded++;
      }
    }
    
    // Pull measurements
    if (data.measurements?.length) {
      for (const m of data.measurements) {
        await db.runAsync(
          `INSERT OR REPLACE INTO body_metrics (date, metric_type, value, unit, synced)
           VALUES (?, ?, ?, ?, 1)`,
          [m.date, m.metric_type, m.value, m.unit || '']
        );
        downloaded++;
      }
    }
    
    // Update last synced timestamp
    await updateLastSyncedAt(Date.now());
    
    console.log('[SYNC] Pulled from cloud:', downloaded, 'items');
    notifyListeners({ type: 'PULL_COMPLETE', downloaded });
    
    return { downloaded };
  } catch (e) {
    console.error('[SYNC] Pull failed:', e.message);
    throw e;
  }
}

export { SYNC_STATUS, ENTITY_TYPES };