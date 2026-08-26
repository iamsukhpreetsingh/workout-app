// Fire-and-forget sync/restore telemetry for the admin dashboard (Phase 11).
// Every function here is best-effort: it NEVER throws, NEVER blocks, and
// silently no-ops when offline or unauthenticated. If these posts fail,
// app functionality is completely unaffected. This module must stay free
// of imports from the sync engine / restore flow to avoid cycles.
import { api } from './api';

export async function postSyncReport(body) {
  try {
    await api('/sync/report', { method: 'POST', body });
  } catch {
    // telemetry must never surface as an error to the caller
  }
}

export async function startRestoreRunReport() {
  try {
    const res = await api('/sync/restore-run/start', { method: 'POST' });
    return res?.runId || null;
  } catch {
    return null;
  }
}

export async function finishRestoreRunReport(runId, status, failedStep = null) {
  if (!runId) return;
  try {
    await api(`/sync/restore-run/${runId}/finish`, { method: 'POST', body: { status, failedStep } });
  } catch {
    // ignore
  }
}
