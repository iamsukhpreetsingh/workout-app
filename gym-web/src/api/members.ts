// Members surface: CRUD, app-connection lifecycle (invite/link/unlink),
// membership cancel/reactivate, and the public invitation bridge.
import { api, UserProfile } from './client';

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

// narrow search used by the front-desk "search and mark" flow
export const searchMembers = (gymId: string, q: string, limit = 1) =>
  listMembers(gymId, { q, limit });

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
