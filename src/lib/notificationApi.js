// Notification API for backend communication
import { api } from './api';

export async function registerPushToken(expoPushToken) {
  await api('/notifications/push-token', {
    method: 'POST',
    body: { expoPushToken },
  });
}

export async function fetchNotifications({ limit = 30, offset = 0 } = {}) {
  return api(`/notifications?limit=${limit}&offset=${offset}`);
}

export async function fetchUnreadCount() {
  const data = await api('/notifications/unread-count');
  return data.count;
}

export async function markNotificationRead(notificationId) {
  return api(`/notifications/${notificationId}/read`, { method: 'PATCH' });
}

export async function dismissNotification(notificationId) {
  return api(`/notifications/${notificationId}/dismiss`, { method: 'PATCH' });
}

export async function markAllNotificationsRead() {
  return api('/notifications/mark-all-read', { method: 'PATCH' });
}