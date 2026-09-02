require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const authRoutes = require('./src/routes/auth');
const passwordResetRoutes = require('./src/routes/passwordReset');
const trainerRoutes = require('./src/routes/trainer');
const clientRoutes = require('./src/routes/client');
const adminAuth = require('./src/admin/auth');
const adminGeneric = require('./src/admin/generic');
const adminModules = require('./src/admin/modules');
const notificationRoutes = require('./src/routes/notifications');
const tagRoutes = require('./src/routes/tags');
const backupRoutes = require('./src/routes/backup');
const progressionRoutes = require('./src/routes/progression');
const syncReportRoutes = require('./src/routes/syncReport');
const exerciseCatalogRoutes = require('./src/routes/exerciseCatalog');
const progressPhotoRoutes = require('./src/routes/progressPhotos');
const { requireAuth } = require('./src/middleware/auth');
const { getUserById } = require('./src/data/users');

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // dish photos arrive as base64

app.get('/health', (req, res) => res.json({ ok: true }));

// Public feature flags — the mobile app polls this on launch/foreground and
// caches locally, enabling remote kill-switches without an app-store release.
app.get('/config/feature-flags', async (req, res) => {
  try {
    const { query } = require('./src/db/pool');
    const { rows } = await query('SELECT key, enabled, rollout_percentage FROM feature_flags');
    res.json(rows);
  } catch {
    res.json([]); // never break app launch over flag fetch failure
  }
});

// // ── dish photos ─────────────────────────────────────────────────────────
// // Unlike progress photos (local-only), catalog dish photos must be visible
// // on OTHER devices (the client viewing an assigned plan), so bytes live on
// // the server: uploads/<uuid>.jpg, DB stores the absolute URL, no base64
// // blobs in Postgres.
// const UPLOAD_DIR = path.join(__dirname, 'uploads');
// fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// app.use('/uploads', express.static(UPLOAD_DIR));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// SECURITY FIX: previously the ENTIRE uploads/ tree was public — including
// uploads/progress-photos/* (private body photos, fetchable by URL with no
// auth). Static serving is now scoped to dish photos only (public catalog
// content); progress photos stream exclusively through the authorized
// /progress-photos/:id/image endpoint after ownership/visibility checks.
app.use('/uploads/dish-photo', express.static(UPLOAD_DIR, { fallthrough: true }));
app.use('/uploads', (req, res, next) => {
  // block direct access to the private subtree; allow legacy dish files
  if (req.path.startsWith('/progress-photos')) {
    return res.status(403).json({ error: 'Progress photos require authorization' });
  }
  next();
}, express.static(UPLOAD_DIR));

app.post('/uploads/dish-photo', requireAuth, async (req, res) => {
  try {
    const b64 = (req.body && req.body.image_base64) || '';
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(b64) || /^([A-Za-z0-9+/=\s]+)$/.exec(b64);
    if (!m) return res.status(400).json({ error: 'image_base64 is required' });
    const raw = Buffer.from(m[m.length - 1], 'base64');
    if (!raw.length || raw.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'image too large (max 8MB)' });
    }
    const name = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), raw);
    res.status(201).json({ url: `${req.protocol}://${req.get('host')}/uploads/${name}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.use('/auth', authRoutes);
app.use('/auth', passwordResetRoutes);
app.use('/trainer', trainerRoutes);
app.use('/gym', require('./src/routes/gym'));
app.use('/client', clientRoutes);

// ── Admin dashboard API (separate auth; every route role-guarded) ──────
app.use('/admin', adminAuth.router);
app.use('/admin', adminGeneric.router);
app.use('/admin', adminModules.router);
// purpose-built admin modules (Phases 5-12) — one router per module
app.use('/admin', require('./src/admin/relationships').router);
app.use('/admin', require('./src/admin/intakeProfiles').router);
app.use('/admin', require('./src/admin/progressionAdmin').router);
app.use('/admin', require('./src/admin/workoutContent').router);
app.use('/admin', require('./src/admin/nutritionAdmin').router);
app.use('/admin', require('./src/admin/syncHealth').router);
app.use('/admin', require('./src/admin/analyticsExtra').router);
// Admin Management (isolated testing section): global formulas, exercise library, unified users
app.use('/admin', require('./src/admin/adminManagement').router);
app.use('/notifications', notificationRoutes);
app.use('/trainer', tagRoutes);
app.use('/user', backupRoutes);
app.use('/', progressionRoutes);
app.use('/sync', syncReportRoutes);
app.use('/exercises', exerciseCatalogRoutes);
app.use('/', progressPhotoRoutes);

// GET /me — current user profile (never includes password_hash)
app.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`workout-tracker backend listening on :${PORT}`);
  // first run: create the initial super admin (credentials logged once)
  adminAuth.ensureBootstrapAdmin().catch((e) => console.error('[ADMIN] bootstrap failed:', e.message));
});
