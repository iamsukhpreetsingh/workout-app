require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const authRoutes = require('./src/routes/auth');
const trainerRoutes = require('./src/routes/trainer');
const clientRoutes = require('./src/routes/client');
const notificationRoutes = require('./src/routes/notifications');
const { requireAuth } = require('./src/middleware/auth');
const { getUserById } = require('./src/data/users');

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // dish photos arrive as base64

app.get('/health', (req, res) => res.json({ ok: true }));

// ── dish photos ─────────────────────────────────────────────────────────
// Unlike progress photos (local-only), catalog dish photos must be visible
// on OTHER devices (the client viewing an assigned plan), so bytes live on
// the server: uploads/<uuid>.jpg, DB stores the absolute URL, no base64
// blobs in Postgres.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

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
app.use('/trainer', trainerRoutes);
app.use('/client', clientRoutes);
app.use('/notifications', notificationRoutes);

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
app.listen(PORT, () => {
  console.log(`workout-tracker backend listening on :${PORT}`);
});
