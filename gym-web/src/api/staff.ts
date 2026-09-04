// Staff management + gym trainer assignments (Phase 8).
import { api } from './client';

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

export const updateStaff = (gymId: string, staffId: string, patch: { gym_role?: string; status?: string }) =>
  api<StaffRow>(`/gym/${gymId}/staff/${staffId}`, { method: 'PATCH', body: patch });

// ── trainer assignments ──────────────────────────────────────────────────

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
