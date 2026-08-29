// Progress Photos routes. Mounted at '/' (like progressionRoutes) so both
// the user paths (/progress-photos...) and the trainer path
// (/trainer/clients/:clientId/progress-photos) resolve — the earlier
// trainer router falls through on this unmatched path.
const express = require('express');
const router = express.Router();
const photos = require('../data/progressPhotos');
const { requireAuth, requireRole } = require('../middleware/auth');
const { registerRoute } = require('../admin/registry');

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// storage internals never reach the client — just a fetchable path the
// mobile app prefixes with the API URL and calls with its auth header
const toClient = (row) => ({
  id: row.id,
  photo_date: row.photo_date,
  visibility: row.visibility,
  image_path: `/progress-photos/${row.id}/image`,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// POST /progress-photos — create or replace-by-date (LWW; idempotent for
// the offline sync engine). Rejects future dates server-side.
registerRoute(router, {
  method: 'POST', path: '/progress-photos',
  description: "Creates (or replaces, last-write-wins) the authenticated user's progress photo for a date. Rejects future dates.",
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    const { photo_date, visibility, image_base64 } = req.body || {};
    res.status(201).json(toClient(await photos.createPhoto(req.user.id, { photo_date, visibility, image_base64 })));
  } catch (e) {
    httpError(res, e, 400);
  }
});

// GET /progress-photos — the caller's own photos, newest date first
registerRoute(router, {
  method: 'GET', path: '/progress-photos',
  description: "Lists the authenticated user's own progress photos, newest date first.",
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    res.json((await photos.listPhotos(req.user.id)).map(toClient));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /progress-photos/:id — own single photo metadata
registerRoute(router, {
  method: 'GET', path: '/progress-photos/:id',
  description: "Returns one of the authenticated user's own progress photos.",
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    res.json(toClient(await photos.getPhoto(req.user.id, req.params.id)));
  } catch (e) {
    httpError(res, e, 404);
  }
});

// PATCH /progress-photos/:id — change visibility and/or replace the image
registerRoute(router, {
  method: 'PATCH', path: '/progress-photos/:id',
  description: "Updates a progress photo's visibility and/or replaces its image (new image persisted before the old one is removed).",
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    const { visibility, image_base64 } = req.body || {};
    res.json(toClient(await photos.updatePhoto(req.user.id, req.params.id, { visibility, image_base64 })));
  } catch (e) {
    httpError(res, e, 400);
  }
});

// DELETE /progress-photos/:id — remove record + stored object
registerRoute(router, {
  method: 'DELETE', path: '/progress-photos/:id',
  description: "Deletes one of the authenticated user's progress photos, including its stored file.",
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await photos.deletePhoto(req.user.id, req.params.id));
  } catch (e) {
    httpError(res, e, 404);
  }
});

// GET /progress-photos/:id/image — THE authorized byte stream. Owner or
// associated trainer (visibility=TRAINER_SHARED) only; everyone else gets
// a 404 that never confirms the photo exists. no-store: private body
// photos must never sit in a shared cache.
registerRoute(router, {
  method: 'GET', path: '/progress-photos/:id/image',
  description: 'Streams a progress photo after ownership/trainer-association/visibility authorization.',
  requiresAuth: true, allowedRoles: ['user', 'trainer'], category: 'Photos',
}, [requireAuth], async (req, res) => {
  try {
    const result = await photos.getPhotoStream(req.user, req.params.id);
    if (!result) return res.status(410).json({ error: 'Photo file is no longer available.' });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    result.stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read photo' });
    });
    result.stream.pipe(res);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients/:clientId/progress-photos — trainer-only; returns
// ONLY that client's TRAINER_SHARED photos (personal never leaves the DB)
// and requires an ACTIVE association (dies at unlink, per spec §21).
registerRoute(router, {
  method: 'GET', path: '/trainer/clients/:clientId/progress-photos',
  description: "Lists a client's trainer-shared progress photos. Requires an active association; personal photos are never returned.",
  requiresAuth: true, allowedRoles: ['trainer'], category: 'Photos',
}, [requireAuth, requireRole('trainer')], async (req, res) => {
  try {
    res.json((await photos.listSharedForTrainer(req.user.id, req.params.clientId)).map(toClient));
  } catch (e) {
    httpError(res, e, 403);
  }
});

module.exports = router;