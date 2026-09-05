// Membership plans + member membership terms and lifecycle (Phases 6-7).
import { api } from './client';

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
  // Phase 16: branches where the plan is sold — [] / omitted = every branch
  branch_ids?: string[];
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
  notes?: string | null;
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

// Phase 13 — scheduled-renewal management: edit (plan/dates/notes) and
// cancel-renewal (distinct from cancelling the current membership). The
// backend enforces LOCKED-WHEN-SCHEDULED pricing and date validation.
export const updateUpcomingMembership = (
  gymId: string, memberId: string, membershipId: string,
  body: { plan_id?: string; starts_on?: string; ends_on?: string; notes?: string }
) => api<MemberMembership>(`/gym/${gymId}/members/${memberId}/memberships/${membershipId}`,
  { method: 'PATCH', body });

export const cancelRenewal = (gymId: string, memberId: string, membershipId: string, reason?: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/members/${memberId}/memberships/${membershipId}/cancel-renewal`,
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
