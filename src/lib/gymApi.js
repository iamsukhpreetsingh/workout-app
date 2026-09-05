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
// Single-flight guard: finishing two workouts back-to-back (or a retry
// racing a slow first call) shares ONE request — the backend is idempotent
// anyway (same local day collapses into the earlier visit), this just
// keeps the UI honest and halves the traffic.
let workoutMarkInFlight = null;
export function markGymAttendanceFromWorkout() {
  if (workoutMarkInFlight) return workoutMarkInFlight;
  workoutMarkInFlight = api('/gym/my/attendance/workout', { method: 'POST' }).finally(() => {
    workoutMarkInFlight = null;
  });
  return workoutMarkInFlight;
}

// ── Gym attendance experience (Mobile M6) ─────────────────────────────
// Member-initiated QR check-in: the poster QR at the gym encodes the
// gym's rotatable secret code (payload gymcheckin:v1:<code> — typed codes
// work too). The backend resolves the gym from the code, verifies the
// caller's membership THERE, and records QR_CHECK_IN under the same
// one-visit-per-day rule as the desk scan. The client never sends a gym id.
export async function checkInWithGymQr(code) {
  return api('/gym/my/attendance/check-in', {
    method: 'POST',
    body: { code },
  });
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


// ── Gym Documents & Digital Waivers (Phase 18) ──────────────────────────────
// Documents belong to the gym member row, so paperwork the desk filed
// BEFORE the app account was connected shows up here too — nothing
// migrates, it was always the member's. Only live documents are listed
// per gym; REPLACED/REVOKED copies stay at the desk (retention).
export async function fetchMyGymDocuments() {
  return api('/gym/my/documents');
}

// Digitally sign a pending waiver/agreement by typing the legal name —
// the typed signature is retained server-side as the signature of record.
// Expired documents refuse; the gym issues a fresh copy instead.
export async function signGymDocument(documentId, signatureName) {
  return api(`/gym/my/documents/${documentId}/sign`, {
    method: 'POST',
    body: { signature_name: signatureName },
  });
}

// ── Gym Foundation (Mobile M1) ──────────────────────────────────────────────
// The member's own ✓/− attendance calendar across ALL their gyms, gym-local:
// [{ gym_id, gym_name, member_code, today, history: […] }]. Server-
// authoritative as always: the member rows come from the JWT, no gym id
// from the client. Since M6 the display is a full month-by-month history
// (see gymState.attendanceMonthRows) and marking is no longer read-only —
// the member can check in via the gym's posted QR (below) or the explicit
// workout-completion prompt (above).
export async function fetchMyGymAttendanceHistory({ days } = {}) {
  // ?days= widens the server window (default 90, capped 365) so the
  // history screen can render previous months. Every row is gym-local and
  // carries the gym's `today` — the device clock is never trusted.
  const qs = days ? `?days=${encodeURIComponent(String(days))}` : '';
  return api(`/gym/my/attendance/history${qs}`);
}

// ── Gym Member Home dashboard (Mobile M5) ────────────────────────────────
// All surfaces below are per-gym arrays keyed by gym_id — the home screen
// slices them to the ACTIVE gym (same shape as fetchMyGymContent; classes
// come from the Phase 17 wrapper above). Everything authoritative stays
// server-side: dues/outstanding are derived from the immutable ledger,
// trainer assignments are the LIVE rows.
export async function fetchMyGymTrainers() {
  return api('/gym/my/trainer');
}

export async function fetchMyGymBilling() {
  return api('/gym/my/billing');
}

// SENT announcements the member was in the audience for, newest first
// (one row per announcement with its richest delivery status).
export async function fetchMyGymAnnouncements({ limit = 20 } = {}) {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return api(`/gym/my/announcements${qs}`);
}
