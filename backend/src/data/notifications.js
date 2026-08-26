// Data access for notifications and push tokens
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Notification types
const NOTIFICATION_TYPES = [
  'workout_assigned',
  'diet_assigned',
  'supplement_assigned',
  'workout_completed',
  'diet_checkin',
  'supplement_checkin',
  'admin_broadcast',    // admin dashboard broadcasts (Phase 10)
  'sync_retry_nudge',   // admin retry-failed-sync nudge (Phase 11)
];

// Create a notification and attempt push delivery
// Returns the created notification
async function createNotification({
  recipientId,
  actorId = null,
  type,
  title,
  body,
  relatedClientId = null,
  deepLinkRef = null,
}) {
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new HttpError(400, `Invalid notification type: ${type}`);
  }
  if (!recipientId || !title || !body) {
    throw new HttpError(400, 'recipientId, title, and body are required');
  }

  // Insert notification
  const { rows } = await query(
    `INSERT INTO notifications (recipient_id, actor_id, type, title, body, related_client_id, deep_link_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [recipientId, actorId, type, title, body, relatedClientId, deepLinkRef]
  );
  const notification = rows[0];

  // Attempt push delivery (fire and forget, don't block)
  sendPushNotification(notification).catch((err) => {
    console.error('Push notification failed:', err.message);
  });

  return notification;
}

// Get push tokens for a user
async function getPushTokens(userId) {
  const { rows } = await query(
    'SELECT expo_push_token FROM push_tokens WHERE user_id = $1',
    [userId]
  );
  return rows.map((r) => r.expo_push_token);
}

// Send push notification via Expo
async function sendPushNotification(notification) {
  const tokens = await getPushTokens(notification.recipient_id);
  if (!tokens.length) return;

  // Get actor name if present
  let actorName = '';
  if (notification.actor_id) {
    const { rows } = await query('SELECT name FROM users WHERE id = $1', [notification.actor_id]);
    actorName = rows[0]?.name || '';
  }

  const expoMessages = tokens.map((token) => ({
    to: token,
    title: notification.title,
    body: notification.body,
    data: {
      type: notification.type,
      deep_link_ref: notification.deep_link_ref,
      related_client_id: notification.related_client_id,
      notification_id: notification.id,
    },
    sound: 'default',
  }));

  // Send to Expo (fire and forget)
  for (const msg of expoMessages) {
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(msg),
      });
    } catch (err) {
      console.error('Failed to send push to token:', token.slice(0, 20) + '...', err.message);
    }
  }
}

// Upsert push token for a user
async function upsertPushToken(userId, expoPushToken) {
  const { rows } = await query(
    `INSERT INTO push_tokens (user_id, expo_push_token, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (expo_push_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       last_seen_at = EXCLUDED.last_seen_at
     RETURNING *`,
    [userId, expoPushToken]
  );
  return rows[0];
}

// Get notifications for a user (non-dismissed only)
async function getNotifications(userId, { limit = 30, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT n.*, u.name AS actor_name
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.recipient_id = $1 AND n.is_dismissed = false
     ORDER BY n.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

// Get unread count for a user
async function getUnreadCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE recipient_id = $1 AND is_read = false AND is_dismissed = false`,
    [userId]
  );
  return rows[0].count;
}

// Mark a notification as read
async function markAsRead(notificationId, userId) {
  const { rows } = await query(
    `UPDATE notifications SET is_read = true
     WHERE id = $1 AND recipient_id = $2
     RETURNING *`,
    [notificationId, userId]
  );
  return rows[0] || null;
}

// Mark a notification as dismissed
async function dismissNotification(notificationId, userId) {
  const { rows } = await query(
    `UPDATE notifications SET is_dismissed = true
     WHERE id = $1 AND recipient_id = $2
     RETURNING *`,
    [notificationId, userId]
  );
  return rows[0] || null;
}

// Mark all notifications as read for a user
async function markAllAsRead(userId) {
  const { rows } = await query(
    `UPDATE notifications SET is_read = true
     WHERE recipient_id = $1 AND is_dismissed = false AND is_read = false
     RETURNING id`,
    [userId]
  );
  return rows.length;
}

// Get trainer-client notification preference
async function getTrainerNotificationPreference(trainerId, clientId) {
  const { rows } = await query(
    `SELECT trainer_notifications_enabled FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status IN ('active', 'archived')
     LIMIT 1`,
    [trainerId, clientId]
  );
  return rows[0]?.trainer_notifications_enabled ?? true;
}

// Update trainer-client notification preference
async function updateTrainerNotificationPreference(trainerId, clientId, enabled) {
  const { rows } = await query(
    `UPDATE trainer_clients SET trainer_notifications_enabled = $3
     WHERE trainer_id = $1 AND client_id = $2 AND status IN ('active', 'archived')
     RETURNING *`,
    [trainerId, clientId, enabled]
  );
  if (!rows.length) {
    throw new HttpError(404, 'No active or archived relationship with this client');
  }
  return rows[0];
}

// Get active trainer for a client (for client -> trainer notifications)
async function getActiveTrainerForClient(clientId) {
  const { rows } = await query(
    `SELECT tc.trainer_id, tc.trainer_notifications_enabled
     FROM trainer_clients tc
     WHERE tc.client_id = $1 AND tc.status = 'active'
     ORDER BY tc.responded_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

// Check if a plan was created by a trainer
async function getPlanCreator(kind, planId) {
  const table = kind === 'diet' ? 'diet_plans' : 'supplement_plans';
  const { rows } = await query(
    `SELECT trainer_id, created_by FROM ${table} WHERE id = $1`,
    [planId]
  );
  return rows[0] || null;
}

// Get user by ID (for getting user names)
async function getUserById(userId) {
  const { rows } = await query('SELECT id, name, email, role FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

module.exports = {
  createNotification,
  getPushTokens,
  upsertPushToken,
  getNotifications,
  getUnreadCount,
  markAsRead,
  dismissNotification,
  markAllAsRead,
  getTrainerNotificationPreference,
  updateTrainerNotificationPreference,
  getActiveTrainerForClient,
  getPlanCreator,
  getUserById,
  NOTIFICATION_TYPES,
};