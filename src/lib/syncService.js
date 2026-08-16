// Invisible reliability layer: background sync of aggregate session
// summaries to POST /client/session-summaries.
//
// Contract:
//  - queueSessionForSync(sessionId): called right after a local save
//    succeeds. Attempts one immediate sync if online; never throws, never
//    blocks, never retries synchronously — the local save already succeeded.
//  - syncPendingSessions(): catch-up for everything still unsynced; called
//    on app foreground / after auth. Batches all pending sessions into one
//    POST.
//
// No screen imports this module's internals — the finish flow and the root
// App foreground listener are the only callers.
import NetInfo from '@react-native-community/netinfo';
import { api } from './api';
import {
  getSessionSyncAggregate,
  getSessionExerciseDetailPayload,
  getUnsyncedSessionIds,
  markSessionsSynced,
  markSessionSyncAttempted,
} from '../db/queries';
import { getUnsyncedMeasurements, markMeasurementsSynced } from '../db/body';

let running = false;

async function isOnline() {
  try {
    const state = await NetInfo.fetch();
    return !!(state.isConnected && state.isInternetReachable !== false);
  } catch {
    // NetInfo unavailable — assume online and let the request decide
    return true;
  }
}

async function pushSummaries(sessionIds) {
  const summaries = [];
  const detailPayloads = [];
  for (const id of sessionIds) {
    const agg = await getSessionSyncAggregate(id);
    if (!agg) continue;
    summaries.push(agg);
    // per-set drill-down rides along — sent AFTER the summary response so
    // we can map server-assigned summary ids. RPE/notes never included.
    const detail = await getSessionExerciseDetailPayload(id);
    if (detail.exercises.length) detailPayloads.push(detail);
  }
  if (!summaries.length) {
    // nothing loadable (e.g. session deleted) — mark done so we don't loop
    await markSessionsSynced(sessionIds);
    return;
  }
  const syncedRows = await api('/client/session-summaries', { method: 'POST', body: summaries });
  await markSessionsSynced(sessionIds);
  // map local_session_id → server summary id, then push the details
  if (detailPayloads.length && Array.isArray(syncedRows)) {
    const idMap = new Map(syncedRows.map((r) => [String(r.local_session_id), r.id]));
    const payloads = detailPayloads
      .map((d) => ({ ...d, session_summary_id: idMap.get(d.local_session_id) }))
      .filter((d) => d.session_summary_id);
    if (payloads.length) {
      await api('/client/session-exercise-details', { method: 'POST', body: payloads });
    }
  }
}

// Fire-and-forget: attempt one immediate sync of a freshly saved session.
// Any failure (offline, timeout, 5xx) is swallowed — the row stays
// synced = 0 and the foreground catch-up will retry.
export async function queueSessionForSync(sessionId) {
  try {
    if (!(await isOnline())) return;
    await pushSummaries([sessionId]);
  } catch {
    try { await markSessionSyncAttempted(sessionId); } catch { /* ignore */ }
  }
}

// Measurement catch-up: batch unsynced body_metrics into one POST.
export async function syncPendingMeasurements() {
  try {
    if (!(await isOnline())) return;
    const entries = await getUnsyncedMeasurements();
    if (!entries.length) return;
    await api('/client/measurements', { method: 'POST', body: entries });
    await markMeasurementsSynced(entries.map((e) => [e.date, e.metric_type]));
  } catch {
    // leave rows unsynced; next foreground retries
  }
}

// Foreground catch-up: batch every unsynced session into one POST.
export async function syncPendingSessions() {
  if (running) return; // avoid overlapping runs on rapid app-state flips
  running = true;
  try {
    if (!(await isOnline())) return;
    const ids = await getUnsyncedSessionIds();
    if (!ids.length) return;
    await pushSummaries(ids);
  } catch {
    // leave rows unsynced; next foreground retries
  } finally {
    running = false;
  }
}
