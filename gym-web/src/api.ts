// Gym portal API client. The portal is just another client of the mobile
// backend: accounts authenticate through /auth (same users table, same JWTs)
// and every gym call carries the access token + the SELECTED gym id. The
// gym id is a selector only — the backend re-resolves role and membership
// from the token on every request.
const ACCESS_KEY = 'gymweb_access';
const REFRESH_KEY = 'gymweb_refresh';
const GYM_KEY = 'gymweb_gym';

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface OperatingHours {
  [day: string]: { open?: string; close?: string; closed?: boolean };
}

export interface Branding {
  primary_color?: string;
  secondary_color?: string;
}

export interface ProfileCompletion {
  percent: number;
  missing: string[];
}

export interface Gym {
  id: string;
  name: string;
  slug: string;
  status?: string;
  gym_status?: string;
  timezone: string;
  currency: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  logo_key?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  operating_hours?: OperatingHours | null;
  branding?: Branding | null;
  profile_completion?: ProfileCompletion;
}

export interface GymMembershipEntry {
  id: string;
  name: string;
  slug: string;
  gym_status: string;
  logo_key: string | null;
  gym_role: string;
  staff_status: string;
  staff_since: string;
}

export function getSelectedGymId(): string | null {
  return localStorage.getItem(GYM_KEY);
}

export function setSelectedGymId(id: string | null) {
  if (id) localStorage.setItem(GYM_KEY, id);
  else localStorage.removeItem(GYM_KEY);
}

export function clearSession() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  setSelectedGymId(null);
}

export async function login(email: string, password: string): Promise<UserProfile> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Login failed');
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return body.user as UserProfile;
}

export async function signup(name: string, email: string, password: string): Promise<UserProfile> {
  const res = await fetch('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, role: 'user' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Sign up failed');
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return body.user as UserProfile;
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  const res = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return true;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const call = () =>
    fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(getSelectedGymId() && path.includes('/gym/') && !path.startsWith('/gym/mine')
          ? { 'X-Gym-Id': getSelectedGymId()! }
          : {}),
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  let res = await call();
  if (res.status === 401 && (await tryRefresh())) res = await call();
  if (res.status === 401) {
    clearSession();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function logout() {
  if (refreshToken) {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  clearSession();
}

export function hasAccessToken(): boolean {
  return !!accessToken;
}

// ── gym surface ──────────────────────────────────────────────────────────

export const getMyGyms = () => api<GymMembershipEntry[]>('/gym/mine');

export interface GymPermissions {
  gymId: string;
  gymName: string;
  gymRole: string;
  isMember: boolean;
  permissions: string[];
}

// The resolved gym context: THE route-guard data source. The portal may
// hide UI by role, but the backend re-checks every request anyway.
export const getGymPermissions = (gymId: string) => api<GymPermissions>(`/gym/${gymId}/permissions`);

export const createGym = (payload: Record<string, any>) =>
  api<{ gym: Gym; membershipRole: string | null; profile_completion: ProfileCompletion }>(
    '/gym', { method: 'POST', body: payload }
  );

export const getGym = (gymId: string) => api<Gym>(`/gym/${gymId}`);

export const updateGym = (gymId: string, patch: Record<string, any>) =>
  api<Gym>(`/gym/${gymId}`, { method: 'PATCH', body: patch });

export const deactivateGym = (gymId: string) =>
  api<Gym>(`/gym/${gymId}/deactivate`, { method: 'POST' });

export const reactivateGym = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/reactivate`, { method: 'POST' });

export const leaveGym = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/leave`, { method: 'POST' });

// Logo upload: file → base64 (the backend validates type via magic bytes
// and enforces the 2MB limit — the client limits are convenience only).
export async function uploadGymLogo(gymId: string, file: File): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
  await api(`/gym/${gymId}/logo`, {
    method: 'POST',
    body: { image_base64: base64, content_type: file.type || 'image/png' },
  });
}

export const removeGymLogo = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/logo`, { method: 'DELETE' });

// The logo endpoint authorizes via the access token, so the <img> needs a
// short-lived blob URL rather than a plain src.
export async function fetchGymLogoBlobUrl(gymId: string): Promise<string | null> {
  const res = await fetch(`/gym/${gymId}/logo`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Timezone choices for the profile forms. Older browsers without
// supportedValuesOf fall back to a small curated list.
export function timezoneOptions(): string[] {
  const supported = (Intl as any).supportedValuesOf?.('timeZone');
  if (Array.isArray(supported) && supported.length) return supported as string[];
  return [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
    'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
    'Australia/Sydney',
  ];
}

// ── members ──────────────────────────────────────────────────────────────

export interface GymMember {
  id: string;
  gym_id: string;
  member_code: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  app_user_id: string | null;
  // independent axes: membership status vs app connection
  status: string;
  app_connection: 'CONNECTED' | 'NOT_CONNECTED' | 'INVITATION_PENDING';
  app_invite_sent_at?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  profile?: Record<string, any> | null;
  joined_at: string;
  notes: string | null;
  created_at: string;
}

export const listMembers = (
  gymId: string,
  params: { q?: string; status?: string; connection?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.status) qs.set('status', params.status);
  if (params.connection) qs.set('connection', params.connection);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<GymMember[]>(`/gym/${gymId}/members?${qs}`);
};

export const getMember = (gymId: string, memberId: string) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}`);

export const createMember = (gymId: string, body: Record<string, any>) =>
  api<GymMember>(`/gym/${gymId}/members`, { method: 'POST', body });

export const updateMember = (gymId: string, memberId: string, patch: Record<string, any>) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}`, { method: 'PATCH', body: patch });

export const linkMemberApp = (gymId: string, memberId: string, email: string) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}/link-app`, { method: 'POST', body: { email } });

export const unlinkMemberApp = (gymId: string, memberId: string) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}/unlink-app`, { method: 'POST' });

// member lifecycle: leave (cancel membership) / reactivate
export const cancelMember = (gymId: string, memberId: string, reason?: string) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}/cancel`, { method: 'POST', body: { reason } });

export const reactivateMember = (gymId: string, memberId: string) =>
  api<GymMember>(`/gym/${gymId}/members/${memberId}/reactivate`, { method: 'POST' });

// app invitations: NOT_CONNECTED → INVITATION_PENDING → CONNECTED
export const inviteMemberApp = (gymId: string, memberId: string, email?: string) =>
  api<{ invite_code: string; email: string }>(
    `/gym/${gymId}/members/${memberId}/invite-app`, { method: 'POST', body: email ? { email } : {} }
  );

export const cancelMemberInvite = (gymId: string, memberId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/members/${memberId}/cancel-invite`, { method: 'POST' });

// ── public invitation bridge (token-keyed; no gym context) ───────────────

export interface InvitationPreview {
  gymName: string;
  gymStatus: string;
  memberName: string;
  memberStatus: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
  invitedAt: string;
  acceptedAt: string | null;
}

export const getInvitation = (token: string) =>
  api<InvitationPreview>(`/gym/invite/${encodeURIComponent(token)}`);

export const acceptInvitationByToken = (token: string) =>
  api<{ ok: boolean; gymName: string }>(`/gym/invite/${encodeURIComponent(token)}/accept`, { method: 'POST' });

export const declineInvitationByToken = (token: string) =>
  api<{ ok: boolean }>(`/gym/invite/${encodeURIComponent(token)}/decline`, { method: 'POST' });

export const registerViaInvitation = (token: string, name: string, password: string) =>
  api<{ ok: boolean; gymName: string; user: UserProfile }>(
    `/gym/invite/${encodeURIComponent(token)}/register`, { method: 'POST', body: { name, password } }
  );

// ── staff ────────────────────────────────────────────────────────────────

export interface StaffRow {
  id: string;
  gym_role: string;
  status: string;
  created_at: string;
  name: string;
  email: string;
}

export const listStaff = (gymId: string) => api<StaffRow[]>(`/gym/${gymId}/staff`);

// adding staff with an email that has no app account returns an INVITATION
// (one-time code shown once) instead of a staff row
export interface AddStaffResult {
  invited?: boolean;
  invite_code?: string;
  email?: string;
  gym_role?: string;
}

export const addStaff = (gymId: string, body: { email: string; gym_role: string }) =>
  api<StaffRow | AddStaffResult>(`/gym/${gymId}/staff`, { method: 'POST', body });

// ── gym trainer assignments (Phase 8) ────────────────────────────────────

export interface TrainerOption {
  trainer_staff_id: string;
  name: string;
  email: string;
}

export interface TrainerAssignment {
  id: string;
  gym_id: string;
  member_id: string;
  trainer_staff_id: string;
  status: 'ACTIVE' | 'ENDED';
  starts_on: string;
  ended_on: string | null;
  end_reason: string | null;
  trainer_name: string;
  trainer_email: string;
  first_name?: string;
  last_name?: string;
  member_code?: string;
  app_user_id?: string | null;
}

export interface TrainerRosterMember {
  assignment_id: string;
  starts_on: string;
  member_id: string;
  member_code: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  member_status: string;
  plan_name: string | null;
  membership_status: string | null;
  ends_on: string | null;
}

export const listAssignableTrainers = (gymId: string) =>
  api<TrainerOption[]>(`/gym/${gymId}/trainers`);

export const getMemberTrainerAssignments = (gymId: string, memberId: string) =>
  api<TrainerAssignment[]>(`/gym/${gymId}/members/${memberId}/trainer`);

export const assignTrainer = (gymId: string, memberId: string, trainerStaffId: string) =>
  api<TrainerAssignment>(`/gym/${gymId}/members/${memberId}/trainer`,
    { method: 'POST', body: { trainer_staff_id: trainerStaffId } });

export const endTrainerAssignment = (gymId: string, memberId: string, assignmentId: string, reason?: string) =>
  api<TrainerAssignment>(`/gym/${gymId}/members/${memberId}/trainer/${assignmentId}/end`,
    { method: 'POST', body: { reason } });

export const listGymTrainerAssignments = (gymId: string, trainerStaffId?: string) =>
  api<TrainerAssignment[]>(`/gym/${gymId}/trainer-assignments${trainerStaffId ? `?trainer_staff_id=${trainerStaffId}` : ''}`);

export const listTrainerRoster = (gymId: string) =>
  api<TrainerRosterMember[]>(`/gym/${gymId}/trainer/members`);

export const updateStaff = (gymId: string, staffId: string, patch: { gym_role?: string; status?: string }) =>
  api<StaffRow>(`/gym/${gymId}/staff/${staffId}`, { method: 'PATCH', body: patch });

// ── membership plans & memberships (Phase 6) ─────────────────────────────

export interface MembershipPlan {
  id: string;
  gym_id: string;
  name: string;
  description: string | null;
  duration_value: number;
  duration_unit: 'day' | 'week' | 'month' | 'year';
  price_cents: number;
  currency: string;
  access_level: 'gym_only' | 'gym_classes' | 'all_access';
  included_pt_sessions: number;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
}

export const listPlans = (gymId: string, status?: string) =>
  api<MembershipPlan[]>(`/gym/${gymId}/plans${status ? `?status=${status}` : ''}`);

export const createPlan = (gymId: string, body: Record<string, any>) =>
  api<MembershipPlan>(`/gym/${gymId}/plans`, { method: 'POST', body });

export const updatePlan = (gymId: string, planId: string, patch: Record<string, any>) =>
  api<MembershipPlan>(`/gym/${gymId}/plans/${planId}`, { method: 'PATCH', body: patch });

export interface MemberMembership {
  id: string;
  gym_id: string;
  member_id: string;
  plan_id: string;
  // snapshots — immune to later plan edits/archival
  plan_name: string;
  plan_duration_value: number;
  plan_duration_unit: string;
  price_cents: number;
  currency: string;
  included_pt_sessions?: number;
  status: 'ACTIVE' | 'FROZEN' | 'UPCOMING' | 'CANCELLED' | 'EXPIRED';
  starts_on: string;
  ends_on: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  // joined fields on the member detail + gym-wide list
  first_name?: string;
  last_name?: string;
  member_code?: string;
}

export const listMemberMemberships = (gymId: string, memberId: string) =>
  api<MemberMembership[]>(`/gym/${gymId}/members/${memberId}/memberships`);

export const assignMembership = (
  gymId: string, memberId: string,
  body: { plan_id: string; starts_on?: string; replace_active?: boolean; cancel_reason?: string }
) => api<MemberMembership>(`/gym/${gymId}/members/${memberId}/memberships`, { method: 'POST', body });

export const cancelMembership = (gymId: string, memberId: string, membershipId: string, reason?: string) =>
  api<MemberMembership>(`/gym/${gymId}/members/${memberId}/memberships/${membershipId}/cancel`,
    { method: 'POST', body: { reason } });

export const renewMembership = (gymId: string, memberId: string, membershipId: string) =>
  api<MemberMembership>(`/gym/${gymId}/members/${memberId}/memberships/${membershipId}/renew`,
    { method: 'POST' });

// lifecycle (Phase 7)
export const freezeMembership = (
  gymId: string, memberId: string, membershipId: string, body: { starts_on?: string; reason?: string }
) => api<{ membership: MemberMembership; freeze: any }>(
  `/gym/${gymId}/members/${memberId}/memberships/${membershipId}/freeze`, { method: 'POST', body }
);

export const resumeMembership = (
  gymId: string, memberId: string, membershipId: string, body: { resumed_on?: string; cancel?: boolean } = {}
) => api<{ membership: MemberMembership; frozen_days: number }>(
  `/gym/${gymId}/members/${memberId}/memberships/${membershipId}/resume`, { method: 'POST', body }
);

export const extendMembership = (gymId: string, memberId: string, membershipId: string, days: number) =>
  api<MemberMembership>(`/gym/${gymId}/members/${memberId}/memberships/${membershipId}/extend`,
    { method: 'POST', body: { days } });

export interface MembershipEvent {
  id: string;
  membership_id: string;
  event: string;
  occurred_on: string;
  details: Record<string, any>;
  actor_name: string | null;
  plan_name: string;
  created_at: string;
}

export const listMembershipEvents = (gymId: string, memberId: string) =>
  api<MembershipEvent[]>(`/gym/${gymId}/members/${memberId}/memberships/events`);

export const listGymMemberships = (
  gymId: string,
  params: { q?: string; status?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.status) qs.set('status', params.status);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<MemberMembership[]>(`/gym/${gymId}/memberships?${qs}`);
};

// ── billing & payment ledger (Phase 9) ───────────────────────────────────

export interface Charge {
  id: string;
  gym_id: string;
  member_id: string;
  membership_id: string | null;
  description: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  due_on: string;
  status: 'DUE' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'REFUNDED';
  paid_total: number;
  net_paid: number;
  outstanding_cents: number;
  first_name?: string;
  last_name?: string;
  member_code?: string;
}

export interface Payment {
  id: string;
  gym_id: string;
  member_id: string;
  charge_id: string;
  amount_cents: number;
  currency: string;
  method: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  paid_on: string;
  receipt_number: string;
  note: string | null;
  status: 'PAID' | 'PARTIAL' | 'REFUNDED';
  refund_total: number;
  first_name?: string;
  last_name?: string;
  member_code?: string;
  charge_description?: string;
  period_start?: string | null;
  period_end?: string | null;
  plan_name?: string | null;
  recorded_by_name?: string | null;
}

export interface BillingSummary {
  revenue_this_month: number;
  collected_total: number;
  due: number;
  overdue: number;
}

export interface Receipt {
  receipt_number: string;
  gym: { name: string; address: string | null; phone: string | null; email: string | null };
  member: { name: string; member_code: string; app_connected: boolean };
  plan: string;
  amount_cents: number;
  currency: string;
  date: string;
  method: string;
  covered_period: { from: string; to: string } | null;
  status: string;
}

export const getBillingSummary = (gymId: string) =>
  api<BillingSummary>(`/gym/${gymId}/payments/summary`);

export const listGymPayments = (
  gymId: string,
  params: { q?: string; method?: string; from?: string; to?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.method) qs.set('method', params.method);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<Payment[]>(`/gym/${gymId}/payments?${qs}`);
};

export const listGymCharges = (gymId: string, params: { status?: string; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  return api<Charge[]>(`/gym/${gymId}/charges?${qs}`);
};

export const getMemberBilling = (gymId: string, memberId: string) =>
  api<{ charges: Charge[]; payments: Payment[] }>(`/gym/${gymId}/members/${memberId}/payments`);

export const createCharge = (
  gymId: string, memberId: string,
  body: { description: string; amount_cents: number; due_on?: string; period_start?: string; period_end?: string }
) => api<Charge>(`/gym/${gymId}/members/${memberId}/charges`, { method: 'POST', body });

export const recordPayment = (
  gymId: string, memberId: string,
  body: { charge_id: string; amount_cents: number; method: string; paid_on?: string; note?: string; allow_duplicate?: boolean }
) => api<Payment>(`/gym/${gymId}/members/${memberId}/payments`, { method: 'POST', body });

export const refundPayment = (
  gymId: string, memberId: string, paymentId: string,
  body: { amount_cents: number; reason?: string }
) => api<{ refund: any; payment: Payment }>(
  `/gym/${gymId}/members/${memberId}/payments/${paymentId}/refund`, { method: 'POST', body }
);

export const getReceipt = (gymId: string, memberId: string, paymentId: string) =>
  api<Receipt>(`/gym/${gymId}/members/${memberId}/payments/${paymentId}/receipt`);

// ── attendance (Phase 10) ────────────────────────────────────────────────

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

// ── gym workouts (Phase 11) ──────────────────────────────────────────────

export interface WorkoutExercise {
  id?: string;
  exercise_name: string;
  sets: number | null;
  reps: string | null;
  duration_minutes: number | null;
  order_index?: number;
  notes: string | null;
}

export interface WorkoutRow {
  id: string;
  gym_id: string;
  title: string;
  description: string | null;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  goal: string;
  estimated_duration_minutes: number | null;
  tags: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  recommended: boolean;
  version: number;
  exercise_count?: number;
  assigned_count?: number;
  saves_count?: number;
  exercises?: WorkoutExercise[];
}

export const listWorkouts = (gymId: string) =>
  api<WorkoutRow[]>(`/gym/${gymId}/workouts`);

export const getWorkout = (gymId: string, workoutId: string) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts/${workoutId}`);

export const createWorkout = (gymId: string, body: Record<string, any>) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts`, { method: 'POST', body });

export const updateWorkout = (gymId: string, workoutId: string, patch: Record<string, any>) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts/${workoutId}`, { method: 'PATCH', body: patch });

export interface WorkoutAssignment {
  id: string;
  gym_id: string;
  workout_id: string;
  member_id: string;
  status: 'ACTIVE' | 'ENDED';
  end_reason: string | null;
  assigned_by_name?: string | null;
  workout_title: string;
  workout_version?: number;
  workout_status?: string;
  difficulty?: string;
  goal?: string;
  first_name?: string;
  last_name?: string;
  member_code?: string;
}

export const listMemberWorkoutAssignments = (gymId: string, memberId: string) =>
  api<WorkoutAssignment[]>(`/gym/${gymId}/members/${memberId}/workout-assignments`);

export const assignWorkout = (gymId: string, memberId: string, workoutId: string) =>
  api<WorkoutAssignment>(`/gym/${gymId}/members/${memberId}/workout-assignments`,
    { method: 'POST', body: { workout_id: workoutId } });

export const endWorkoutAssignment = (gymId: string, memberId: string, assignmentId: string, reason?: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/workout-assignments/${assignmentId}/end`,
    { method: 'POST', body: { reason } });

export const listAssignableWorkouts = (gymId: string) =>
  api<WorkoutRow[]>(`/gym/${gymId}/workouts?status=PUBLISHED`);

// money helpers: stored as integer minor units, displayed in major units
export function formatMoney(cents: number, currency: string): string {
  const symbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency] || `${currency} `;
  return `${symbol}${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
