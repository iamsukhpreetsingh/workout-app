// Gym branches (Phase 16): the Gym stays the tenant, branches are its
// subdivisions. Branches are never deleted — they are CLOSED (INACTIVE);
// history, members and staff links survive a closure. Access model:
//   staff   branch_ids [] = all branches, else restricted
//   member  access = {primary} ∪ allowed_branch_ids (no primary = legacy,
//           all branches)
import { api } from './client';

export interface Branch {
  id: string;
  gym_id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  operating_hours: Record<string, { open: string; close: string; closed?: boolean }> | null;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  // list enrichment
  members?: number;
  active_members?: number;
  checkins_today?: number;
}

export interface BranchPayload {
  name: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  phone?: string;
  email?: string;
  operating_hours?: Record<string, { open: string; close: string; closed?: boolean }>;
  timezone?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface BranchTransfer {
  id: string;
  member_id: string;
  from_branch_id: string | null;
  to_branch_id: string | null;
  from_branch_name?: string | null;
  to_branch_name?: string | null;
  reason: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface StaffMemberWithBranches {
  id: string;
  user_id: string;
  email?: string;
  name?: string;
  gym_role: string;
  status: string;
  branch_ids: string[];
  [key: string]: unknown;
}

// ── branch CRUD (branches.manage) ──────────────────────────────────────────

export const listBranches = (gymId: string) =>
  api<Branch[]>(`/gym/${gymId}/branches`);

export const getBranch = (gymId: string, branchId: string) =>
  api<Branch>(`/gym/${gymId}/branches/${branchId}`);

export const createBranch = (gymId: string, body: BranchPayload) =>
  api<Branch>(`/gym/${gymId}/branches`, { method: 'POST', body });

export const updateBranch = (gymId: string, branchId: string, patch: Partial<BranchPayload>) =>
  api<Branch>(`/gym/${gymId}/branches/${branchId}`, { method: 'PATCH', body: patch });

export const closeBranch = (gymId: string, branchId: string) =>
  api<Branch>(`/gym/${gymId}/branches/${branchId}/close`, { method: 'POST' });

export const reopenBranch = (gymId: string, branchId: string) =>
  api<Branch>(`/gym/${gymId}/branches/${branchId}/reopen`, { method: 'POST' });

// ── member ↔ branch (members.manage / members.view) ────────────────────────

export const setMemberBranches = (
  gymId: string,
  memberId: string,
  body: { primary_branch_id?: string | null; allowed_branch_ids?: string[] },
) =>
  api(`/gym/${gymId}/members/${memberId}/branches`, { method: 'PATCH', body });

export const transferMemberBranch = (
  gymId: string,
  memberId: string,
  body: { to_branch_id: string; reason?: string },
) =>
  api(`/gym/${gymId}/members/${memberId}/transfer-branch`, { method: 'POST', body });

export const memberBranchHistory = (gymId: string, memberId: string) =>
  api<BranchTransfer[]>(`/gym/${gymId}/members/${memberId}/branch-history`);

// ── staff branch restriction (staff.manage) ────────────────────────────────

export const setStaffBranches = (gymId: string, staffId: string, branchIds: string[]) =>
  api<StaffMemberWithBranches>(`/gym/${gymId}/staff/${staffId}/branches`, {
    method: 'PATCH',
    body: { branch_ids: branchIds },
  });
