require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
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

// ── security headers (no external dep — helmet-equivalent minimum set) ──
// API + private uploads only; gym-web is served separately by its own host.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin'); // uploads embedded by the portal origin
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── CORS allowlist ──────────────────────────────────────────────────────
// Bearer-token API: browsers only need CORS for the web portal. Origins are
// an explicit allowlist (env CORS_ORIGINS, comma-separated) plus the local
// dev defaults; unknown origins simply get no CORS headers, which browsers
// treat as blocked. Non-browser clients (mobile, curl) send no Origin and
// are unaffected.
const CORS_ORIGINS = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'])
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gym-Id');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

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
  // block direct access to the private subtrees; allow legacy dish files
  if (req.path.startsWith('/progress-photos')) {
    return res.status(403).json({ error: 'Progress photos require authorization' });
  }
  // Phase 18: member documents (waivers, ID scans, medical clearances) —
  // the most sensitive files in the system. Bytes move ONLY through the
  // authorized document endpoints after permission + branch checks.
  if (req.path.startsWith('/gym-documents')) {
    return res.status(403).json({ error: 'Member documents require authorization' });
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
    // magic-byte check: the bytes really must be the image the client claims,
    // otherwise arbitrary content (HTML/JS) would be stored and served from
    // our origin as .jpg (stored-XSS vector once nosniff is missing)
    const isJpeg = raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
    const isPng = raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
    const isWebp = raw.slice(0, 4).toString('latin1') === 'RIFF' && raw.slice(8, 12).toString('latin1') === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({ error: 'Only real PNG, JPEG or WEBP images are accepted' });
    }
    const name = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), raw);
    // RELATIVE url — never reflect the client-controlled Host header into
    // stored data; clients resolve it against their known API base
    res.status(201).json({ url: `/uploads/${name}` });
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
  console.error(err); // detail stays server-side only
  // Known client-error classes get their real status instead of a blanket 500:
  //   body-parser PayloadTooLargeError → 413, JSON SyntaxError → 400,
  //   pg 22P02 (invalid uuid/int text representation) → 400 invalid id
  const pgInvalidCast = err && (err.code === '22P02' || /invalid input syntax for (type )?(uuid|integer)/.test(err.message || ''));
  const status = pgInvalidCast ? 400 : (err.status || err.statusCode || 500);
  const message = pgInvalidCast ? 'Invalid id format'
    : status === 413 ? 'Request body too large'
    : status === 400 && err.type === 'entity.parse.failed' ? 'Malformed JSON body'
    : status >= 500 ? 'Internal server error' : (err.message || 'Request failed');
  res.status(status).json({ error: message });
});

// SECURITY: required secrets — the server refuses to start unconfigured
// rather than degrading into a guessable-token deployment.
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start (tokens would be unsigned/unverifiable).');
  process.exit(1);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`workout-tracker backend listening on :${PORT}`);
  // first run: create the initial super admin (credentials logged once)
  adminAuth.ensureBootstrapAdmin().catch((e) => console.error('[ADMIN] bootstrap failed:', e.message));
});
