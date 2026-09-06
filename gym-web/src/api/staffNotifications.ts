// Staff Notification Center API — recipient-scoped gym notifications.
// The backend resolves BOTH the gym (requireGymContext) and the recipient
// (recipient_user_id = the authenticated user) server-side; the portal can
// never read another staff member's or another gym's notifications.
import { api } from './client';

export interface StaffNotification {
  id: string;
  type: string;
  category: string;
  severity: 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  member_id: string | null;
  member_name?: string | null;
  member_code?: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
  metadata: Record<string, any>;
}

export const listStaffNotifications = (
  gymId: string,
  params: { unread?: boolean; category?: string; severity?: string; member_id?: string; q?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.unread) qs.set('unread', '1');
  if (params.category) qs.set('category', params.category);
  if (params.severity) qs.set('severity', params.severity);
  if (params.member_id) qs.set('member_id', params.member_id);
  if (params.q) qs.set('q', params.q);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<StaffNotification[]>(`/gym/${gymId}/staff-notifications?${qs}`);
};

export const getStaffUnreadCount = (gymId: string) =>
  api<{ count: number }>(`/gym/${gymId}/staff-notifications/unread-count`);

export const markStaffNotificationsRead = (gymId: string, ids: string[]) =>
  api<{ marked: number }>(`/gym/${gymId}/staff-notifications/read`, { method: 'POST', body: { ids } });

export const markAllStaffNotificationsRead = (gymId: string) =>
  api<{ marked: number }>(`/gym/${gymId}/staff-notifications/read-all`, { method: 'POST' });
