// Gym classes (Phase 17): scheduled class instances — type, trainer,
// branch, room, date, start/end time, capacity — plus bookings with a
// FIFO waitlist. A class is never edited into the past: cancelling is
// terminal and cascades to every live booking (reason class_cancelled).
import { api } from './client';

export interface GymClass {
  id: string;
  gym_id: string;
  branch_id: string | null;
  class_type: string;
  trainer_staff_id: string | null;
  room: string | null;
  class_date: string;
  start_time: string;
  end_time: string;
  capacity: number;
  notes: string | null;
  status: 'SCHEDULED' | 'CANCELLED';
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  // list enrichment
  branch_name?: string | null;
  trainer_name?: string | null;
  booked_count?: number;
  waitlist_count?: number;
}

export interface ClassBooking {
  id: string;
  class_id: string;
  member_id: string;
  status: 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';
  source: 'DESK' | 'SELF';
  booked_at: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  attended_at?: string | null;
  member_code: string;
  first_name: string | null;
  last_name: string | null;
  waitlist_position?: number;
}

export interface ClassBookingResult {
  id: string;
  class_id: string;
  member_id: string;
  status: 'BOOKED' | 'WAITLISTED';
  waitlist_position: number | null;
  spots_left: number;
}

export interface ClassPayload {
  class_type: string;
  trainer_staff_id?: string | null;
  branch_id?: string | null;
  room?: string | null;
  class_date: string;
  start_time: string;
  end_time: string;
  capacity: number;
  notes?: string | null;
}

export interface ClassListParams {
  from?: string;
  to?: string;
  status?: 'SCHEDULED' | 'CANCELLED' | 'ALL';
  branch_id?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

// ── class management (classes.manage) ──────────────────────────────────────

export const listClasses = (gymId: string, params: ClassListParams = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return api<GymClass[]>(`/gym/${gymId}/classes${suffix}`);
};

export const getClass = (gymId: string, classId: string) =>
  api<GymClass & { bookings: ClassBooking[] }>(`/gym/${gymId}/classes/${classId}`);

export const createClass = (gymId: string, body: ClassPayload) =>
  api<GymClass>(`/gym/${gymId}/classes`, { method: 'POST', body });

export const updateClass = (gymId: string, classId: string, patch: Partial<ClassPayload>) =>
  api<GymClass>(`/gym/${gymId}/classes/${classId}`, { method: 'PATCH', body: patch });

export const cancelClass = (gymId: string, classId: string, reason?: string) =>
  api<GymClass>(`/gym/${gymId}/classes/${classId}/cancel`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });

// ── bookings (checkin.manage or classes.manage) ────────────────────────────

export const bookMember = (gymId: string, classId: string, memberId: string) =>
  api<ClassBookingResult>(`/gym/${gymId}/classes/${classId}/bookings`, {
    method: 'POST',
    body: { member_id: memberId },
  });

export const cancelBooking = (gymId: string, classId: string, bookingId: string, reason?: string) =>
  api<{ id: string; status: string; promoted: number }>(
    `/gym/${gymId}/classes/${classId}/bookings/${bookingId}/cancel`,
    { method: 'POST', body: reason ? { reason } : {} },
  );

export const setAttendance = (
  gymId: string,
  classId: string,
  bookingId: string,
  attendance: 'ATTENDED' | 'NO_SHOW' | 'BOOKED',
) =>
  api<{ id: string; status: string; promoted: number }>(
    `/gym/${gymId}/classes/${classId}/bookings/${bookingId}/attendance`,
    { method: 'POST', body: { attendance } },
  );
