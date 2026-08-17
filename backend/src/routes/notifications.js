const express = require('express');
const notifications = require('../data/notifications');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// POST /notifications/push-token — register Expo push token
router.post('/push-token', requireAuth, async (req, res) => {
  try {
    const { expoPushToken } = req.body || {};
    if (!expoPushToken) {
      return res.status(400).json({ error: 'expoPushToken is required' });
    }
    const token = await notifications.upsertPushToken(req.user.id, expoPushToken);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e);
  }
});

// GET /notifications — get user's notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const notifs = await notifications.getNotifications(req.user.id, { limit, offset });
    res.json(notifs);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /notifications/unread-count — get unread count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await notifications.getUnreadCount(req.user.id);
    res.json({ count });
  } catch (e) {
    httpError(res, e);
  }
});

// PATCH /notifications/:id/read — mark as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const notif = await notifications.markAsRead(req.params.id, req.user.id);
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json(notif);
  } catch (e) {
    httpError(res, e);
  }
});

// PATCH /notifications/:id/dismiss — dismiss notification
router.patch('/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const notif = await notifications.dismissNotification(req.params.id, req.user.id);
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json(notif);
  } catch (e) {
    httpError(res, e);
  }
});

// PATCH /notifications/mark-all-read — mark all as read
router.patch('/mark-all-read', requireAuth, async (req, res) => {
  try {
    const count = await notifications.markAllAsRead(req.user.id);
    res.json({ marked_count: count });
  } catch (e) {
    httpError(res, e);
  }
});

module.exports = router;