// Deep-link resolution for staff notifications: entity_type → portal route.
// The backend stores structured references (entity_type/entity_id/member_id),
// never frontend URLs; this is the single place that maps them to the
// portal's routing architecture. Unknown types fall back to the member (if
// any) or null (row is not clickable).
import type { StaffNotification } from '../api/staffNotifications';

const MEMBER_TAB: Record<string, string> = {
  PAYMENT: 'payments',
  PAYMENT_PROOF: 'payments',
  CHARGE: 'payments',
  MEMBERSHIP: 'membership',
  TRAINER_ASSIGNMENT: 'trainer',
  WORKOUT_ASSIGNMENT: 'workouts',
  NUTRITION_ASSIGNMENT: 'nutrition',
  DOCUMENT: 'documents',
};

export function notificationHref(n: StaffNotification): string | null {
  const t = n.entity_type || '';
  if (t.startsWith('CLASS')) return '/classes';
  if (t === 'STAFF' || t === 'SECURITY') return '/staff';
  if (n.member_id) {
    const tab = MEMBER_TAB[t];
    return `/members/${n.member_id}${tab ? `/${tab}` : ''}`;
  }
  return null;
}
