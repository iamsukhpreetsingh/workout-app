// Attendance (Phase 10): QR scan, front-desk marking, backdating (owners),
// stats, member ✓/− calendar, QR tokens.
import { api } from './client';

export type AttendanceSource = 'QR_CHECK_IN' | 'FRONT_DESK' | 'WORKOUT_COMPLETION' | 'ADMIN_MANUAL';

export interface AttendanceRecord {
  id: string;
  gym_id: string;
  member_id: string;
  source: AttendanceSource;
  check_in_at: string;
  local_date: string;
  client_time: string | null;
  time_corrected: boolean;
  note: string | null;
  first_name?: string;
  last_name?: string;
  member_code?: string;
  recorded_by_name?: string | null;
}

export interface ScanResult {
  attendance: AttendanceRecord;
  duplicate: boolean;
  warning?: string | null;
  member: { id: string; name: string; member_code: string };
}

export interface AttendanceStats {
  today_count: number;
  week_count: number;
  month_count: number;
  peak_hours: { hour: number; count: number }[] | null;
  inactive_members: { member_id: string; first_name: string; last_name: string | null; member_code: string; last_visit: string | null }[] | null;
}

export interface MemberDay {
  date: string;
  present: boolean;
  source: AttendanceSource | null;
}

export interface MemberQr {
  id: string;
  member_code: string;
  qr_token: string;
  qr_issued_at: string;
}

export const scanQr = (gymId: string, qrToken: string) =>
  api<ScanResult>(`/gym/${gymId}/attendance/scan`, { method: 'POST', body: { qr_token: qrToken } });

export const markAttendance = (gymId: string, memberId: string) =>
  api<ScanResult>(`/gym/${gymId}/members/${memberId}/attendance`, { method: 'POST' });

export const backdateAttendance = (gymId: string, memberId: string, localDate: string) =>
  api<ScanResult>(`/gym/${gymId}/members/${memberId}/attendance/backdate`,
    { method: 'POST', body: { local_date: localDate } });

export const deleteAttendance = (gymId: string, attendanceId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/attendance/${attendanceId}`, { method: 'DELETE' });

export const listAttendance = (gymId: string, params: { date?: string; member_id?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set('date', params.date);
  if (params.member_id) qs.set('member_id', params.member_id);
  return api<AttendanceRecord[]>(`/gym/${gymId}/attendance?${qs}`);
};

export const getAttendanceStats = (gymId: string) =>
  api<AttendanceStats>(`/gym/${gymId}/attendance/stats`);

export const getMemberAttendanceHistory = (gymId: string, memberId: string, days = 90) =>
  api<MemberDay[]>(`/gym/${gymId}/members/${memberId}/attendance/history?days=${days}`);

export const getMemberQr = (gymId: string, memberId: string) =>
  api<MemberQr>(`/gym/${gymId}/members/${memberId}/qr`);

export const rotateMemberQr = (gymId: string, memberId: string) =>
  api<MemberQr>(`/gym/${gymId}/members/${memberId}/qr/rotate`, { method: 'POST' });

// ── Door poster check-in code (Mobile M6) ────────────────────────────────
// The QR members scan at the door encodes a 128-bit gym secret (NOT the
// gym id — a guessable id would let anyone fabricate check-ins). The
// backend get-or-creates it; rotating invalidates every printed poster.
export interface GymCheckinCode {
  checkin_code: string;
}

// The full payload printed into the poster QR. The mobile check-in screen
// also accepts the bare code when typed by hand (it strips this prefix
// case-insensitively server-side), so posters stay scannable AND readable.
export const checkinPosterPayload = (code: string) => `gymcheckin:v1:${code}`;

export const getCheckinCode = (gymId: string) =>
  api<GymCheckinCode>(`/gym/${gymId}/attendance/checkin-code`);

export const rotateCheckinCode = (gymId: string) =>
  api<GymCheckinCode>(`/gym/${gymId}/attendance/checkin-code/rotate`, { method: 'POST' });
