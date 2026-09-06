// Leads API — gym-side management of public QR enquiries (leads.view/manage).
import { api } from './client';

export interface GymLead {
  id: string;
  gym_id: string;
  full_name: string;
  phone: string;
  email: string | null;
  enquiry_type: 'ENQUIRY' | 'TRIAL' | 'VISITOR' | 'MEMBERSHIP_ENQUIRY' | 'GENERAL_ENQUIRY';
  status: 'NEW' | 'CONTACTED' | 'TRIAL_SCHEDULED' | 'TRIAL_COMPLETED' | 'JOINED'
    | 'NOT_JOINED' | 'NO_RESPONSE' | 'FOLLOW_UP' | 'CLOSED';
  source: string;
  message: string | null;
  preferred_visit_on: string | null;
  matched_member_id: string | null;
  converted_member_id: string | null;
  converted_member?: { id: string; name: string; member_code: string } | null;
  matched_member?: { id: string } | null;
  created_at: string;
  updated_at: string;
  note_count?: number;
  notes?: { id: string; note: string; created_at: string; created_by_name: string | null }[];
  activity?: { action: string; created_at: string; actor_label: string | null;
    before: any; after: any }[];
}

export const getLeadLanding = (token: string) =>
  api<{ state: string; gym_name?: string; city?: string | null; types?: string[] }>(
    `/gym/leads/public/${encodeURIComponent(token)}`
  );

export const listLeads = (
  gymId: string,
  params: { status?: string; type?: string; q?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.q) qs.set('q', params.q);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<GymLead[]>(`/gym/${gymId}/leads?${qs}`);
};

export const getLead = (gymId: string, leadId: string) =>
  api<GymLead>(`/gym/${gymId}/leads/${leadId}`);

export const updateLeadStatus = (gymId: string, leadId: string, status: string) =>
  api<GymLead>(`/gym/${gymId}/leads/${leadId}/status`, { method: 'POST', body: { status } });

export const addLeadNote = (gymId: string, leadId: string, note: string) =>
  api<{ id: string; note: string; created_at: string }>(
    `/gym/${gymId}/leads/${leadId}/notes`, { method: 'POST', body: { note } }
  );

export const convertLead = (gymId: string, leadId: string, memberId: string) =>
  api<GymLead>(`/gym/${gymId}/leads/${leadId}/convert`, { method: 'POST', body: { member_id: memberId } });

export const getLeadQrCode = (gymId: string) =>
  api<{ lead_qr_code: string }>(`/gym/${gymId}/leads/qr-code`);

export const rotateLeadQrCode = (gymId: string) =>
  api<{ lead_qr_code: string }>(`/gym/${gymId}/leads/qr-code/rotate`, { method: 'POST' });
