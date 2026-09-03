// Gym API — member-facing "My Gym" data (Phase 5). Server-authoritative:
// the backend resolves the caller's gym_members rows from the JWT, so no
// gym state is stored locally or synced (online-viewed like notifications).
import { api } from './api';

export async function fetchMyGymMemberships() {
  // rows where THIS user is the app-linked member: gym name, member code,
  // membership status. Standalone users get [] — the gym is never required.
  return api('/gym/my/memberships');
}

// Phase 10 — called after a workout is saved. Returns whether an ACTIVE
// gym membership term exists (only then should the app prompt "Mark
// today's gym attendance?"); standalone users and frozen/expired terms
// return false. Never throws — attendance is best-effort.
export async function hasActiveGymMembership() {
  try {
    const rows = await fetchMyGymMemberships();
    return Array.isArray(rows) && rows.some((m) => m.membership_status === 'ACTIVE');
  } catch {
    return false;
  }
}

// The actual mark. Server-side this is source WORKOUT_COMPLETION and the
// idempotency rule collapses it into an earlier QR/desk check-in — the
// same intended visit is never double-counted.
export async function markGymAttendanceFromWorkout() {
  return api('/gym/my/attendance/workout', { method: 'POST' });
}
