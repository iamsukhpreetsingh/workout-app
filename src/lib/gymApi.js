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

// Phase 13 — UNIFIED gym content surface, one call for everything the
// member can see: per ACTIVE-membership gym,
//   { gym_id, gym_name,
//     workouts:   { recommended: [...], assigned: [...] },
//     nutrition:  { recommended: [...], assigned: [...] } }
// Assigned rows are window-aware: SCHEDULED rows appear from starts_on,
// EXPIRED rows drop off after ends_on; each carries assignment_id,
// starts_on, ends_on, notes and assigned_version. Recommended rows require
// an ACTIVE membership term (the gym's "Gym Recommended" distribution).
export async function fetchMyGymContent() {
  return api('/gym/my/content');
}

// The actual mark. Server-side this is source WORKOUT_COMPLETION and the
// idempotency rule collapses it into an earlier QR/desk check-in — the
// same intended visit is never double-counted.
export async function markGymAttendanceFromWorkout() {
  return api('/gym/my/attendance/workout', { method: 'POST' });
}


// ── Gym Classes (Phase 17) ──────────────────────────────────────────────────
// Upcoming scheduled classes across the member's ACTIVE gym memberships,
// branch-filtered to what they can access, with spots left and the member's
// own live booking status per class.
export async function fetchMyGymClasses() {
  return api('/gym/my/classes');
}

// Book a class from the app. If the class is full the member is waitlisted
// (FIFO) — the response carries status BOOKED | WAITLISTED.
export async function bookGymClass(classId) {
  return api(`/gym/my/classes/${classId}/book`, { method: 'POST' });
}

// Cancel the member's own live booking (seat or waitlist spot). Cancelling
// a seat promotes the earliest waitlisted member.
export async function cancelMyGymClassBooking(classId) {
  return api(`/gym/my/classes/${classId}/cancel`, { method: 'POST' });
}
