const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../data/users');
const tags = require('../data/tags');
const { registerRoute } = require('../admin/registry');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ACCESS_TTL = '30m';
const REFRESH_TTL_DAYS = 30;
const BCRYPT_COST = 11;

function signAccessToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
}

function signRefreshToken(user, jti) {
  return jwt.sign({ id: user.id, jti }, process.env.JWT_SECRET, {
    expiresIn: `${REFRESH_TTL_DAYS}d`,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /auth/signup
registerRoute(
  router,
  {
    method: 'POST',
    path: '/signup',
    description: 'Create a new user or trainer account and return initial access/refresh tokens',
    requiresAuth: false,
    allowedRoles: ['public'],
    category: 'Auth',
  },
  async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (role !== 'user' && role !== 'trainer') {
      return res.status(400).json({ error: "Role must be 'user' or 'trainer'" });
    }
    const existing = await users.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const user = await users.createUser({ email, passwordHash, name: name.trim(), role });

    // Seed default tags for trainers on signup
    if (role === 'trainer') {
      await tags.seedDefaultTags(user.id);
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
    await users.storeRefreshToken(user.id, refreshToken, expiresAt);

    res.status(201).json({ user, accessToken, refreshToken });
  } catch (e) {
    next(e);
  }
});

// POST /auth/login
registerRoute(
  router,
  {
    method: 'POST',
    path: '/login',
    description: 'Authenticate with email/password; blocked when the account is suspended by an admin',
    requiresAuth: false,
    allowedRoles: ['public'],
    category: 'Auth',
  },
  async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await users.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    // admin-dashboard suspension (admin_users Phase 4) blocks app login
    if (user.is_suspended) {
      return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
    await users.storeRefreshToken(user.id, refreshToken, expiresAt);

    // Seed default tags for trainers on first login (if not already seeded)
    if (user.role === 'trainer') {
      const existingTags = await tags.getTagsForTrainer(user.id);
      if (existingTags.length === 0) {
        await tags.seedDefaultTags(user.id);
      }
    }

    // never leak password_hash
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, accessToken, refreshToken });
  } catch (e) {
    next(e);
  }
});

// POST /auth/refresh — one refresh token → new access token (+ rotation)
registerRoute(
  router,
  {
    method: 'POST',
    path: '/refresh',
    description: 'Exchange a valid refresh token for a new access token, rotating the refresh token',
    requiresAuth: false,
    allowedRoles: ['public (valid refresh token)'],
    category: 'Auth',
  },
  async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    const stored = await users.findValidRefreshToken(refreshToken);
    if (!stored) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    await users.revokeRefreshToken(refreshToken);
    const user = await users.getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    const newAccess = signAccessToken(user);
    const newRefresh = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
    await users.storeRefreshToken(user.id, newRefresh, expiresAt);

    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (e) {
    next(e);
  }
});

// POST /auth/logout — revoke the refresh token server-side
registerRoute(
  router,
  {
    method: 'POST',
    path: '/logout',
    description: 'Revoke the supplied refresh token (server-side logout)',
    requiresAuth: false,
    allowedRoles: ['public'],
    category: 'Auth',
  },
  async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) await users.revokeRefreshToken(refreshToken);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});


// PATCH /auth/profile — update the authenticated user's editable profile
// fields. Name only for now: email is the auth identity (changing it would
// require a verification flow and is deliberately NOT supported here), and
// body metrics live in the client intake profile. The users row is the
// authoritative profile source — no separate profile copy.
const { query } = require('../db/pool');
registerRoute(
  router,
  {
    method: 'PATCH',
    path: '/profile',
    description: "Updates the authenticated user's display name (the only editable core profile field; email is the auth identity and is not editable here).",
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Auth',
  },
  [requireAuth, requireRole(['user', 'trainer'])],
  async (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim();
      if (!name || name.length > 80) {
        return res.status(400).json({ error: 'name is required (max 80 characters)' });
      }
      const { rows } = await query(
        'UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name, email, role',
        [req.user.id, name]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Unexpected error' });
    }
  }
);

// shared with the authenticated change-password flow so access/refresh
// tokens are always signed identically (same claims, same TTLs)
module.exports = router;
module.exports.signAccessToken = signAccessToken;
module.exports.signRefreshToken = signRefreshToken;
module.exports.REFRESH_TTL_DAYS = REFRESH_TTL_DAYS;
