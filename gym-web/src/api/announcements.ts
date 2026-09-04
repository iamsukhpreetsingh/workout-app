// Gym announcements (Phase 14): DRAFT → SCHEDULED → SENT lifecycle,
// send-time audience resolution and the per-recipient delivery ledger.
// scheduled_for is a GYM-LOCAL wall time "YYYY-MM-DD HH:mm" — the backend
// converts it with the gym's timezone.
import { api } from './client';

export type AudienceType = 'ALL_ACTIVE_MEMBERS' | 'SPECIFIC_MEMBERS' | 'SPECIFIC_BRANCH';
export type AnnouncementStatus = 'DRAFT' | 'SCHEDULED' | 'SENT' | 'CANCELLED';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface Announcement {
  id: string;
  gym_id: string;
  title: string;
  body: string;
  audience_type: AudienceType;
  audience_member_ids: string[] | null;
  audience_branch: string | null;
  status: AnnouncementStatus;
  scheduled_for: string | null;
  scheduled_for_local?: string | null;   // "YYYY-MM-DD HH:mm" in the gym's tz
  published_at: string | null;
  published_at_local?: string | null;
  created_at: string;
  created_by_name?: string | null;
  // list enrichment
  sent_count?: number;
  skipped_count?: number;
  failed_count?: number;
  queued_count?: number;
  current_audience_size?: number;
  // publish-now response
  delivery_summary?: { audience?: number; sent: number; skipped: number; failed: number };
}

export interface AnnouncementDelivery {
  id: string;
  announcement_id: string;
  member_id: string;
  channel: 'IN_APP' | 'PUSH' | 'EMAIL';
  status: DeliveryStatus;
  detail: string | null;
  sent_at: string | null;
  created_at: string;
  first_name: string;
  last_name?: string | null;
  member_code: string;
  app_user_id: string | null;
  email?: string | null;
}

export interface AnnouncementDetail extends Announcement {
  deliveries: AnnouncementDelivery[];
  delivery_summary: { sent: number; skipped: number; failed: number; queued: number };
}

export interface AnnouncementPayload {
  title: string;
  body: string;
  audience_type: AudienceType;
  audience_member_ids?: string[];
  audience_branch?: string;
  scheduled_for?: string;   // "YYYY-MM-DD HH:mm" gym-local; omit → DRAFT
}

export const createAnnouncement = (gymId: string, body: AnnouncementPayload) =>
  api<Announcement>(`/gym/${gymId}/announcements`, { method: 'POST', body });

export const listAnnouncements = (gymId: string, filters: { status?: string; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.q) qs.set('q', filters.q);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return api<Announcement[]>(`/gym/${gymId}/announcements${suffix}`);
};

export const getAnnouncement = (gymId: string, id: string) =>
  api<AnnouncementDetail>(`/gym/${gymId}/announcements/${id}`);

export const updateAnnouncement = (gymId: string, id: string, patch: Partial<AnnouncementPayload>) =>
  api<Announcement>(`/gym/${gymId}/announcements/${id}`, { method: 'PATCH', body: patch });

export const publishAnnouncement = (gymId: string, id: string) =>
  api<Announcement>(`/gym/${gymId}/announcements/${id}/publish`, { method: 'POST' });

export const cancelAnnouncement = (gymId: string, id: string, reason?: string) =>
  api<Announcement>(`/gym/${gymId}/announcements/${id}/cancel`, { method: 'POST', body: { reason } });

export const dispatchDueAnnouncements = (gymId: string) =>
  api<{ dispatched: number; rescued: number; announcement_ids: string[] }>(
    `/gym/${gymId}/announcements/dispatch-due`, { method: 'POST' });
