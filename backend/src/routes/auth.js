const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../data/users');
const intakeProfiles = require('../data/intakeProfiles');
const { query, pool } = require('../db/pool');
const tags = require('../data/tags');
const { registerRoute } = require('../admin/registry');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit, createFailureTracker } = require('../middleware/rateLimit');

const router = express.Router();

const ACCESS_TTL = '30m';
const REFRESH_TTL_DAYS = 30;
const BCRYPT_COST = 11;

// Brute-force guard: counts only FAILED logins per (account, IP). 15 misses
// per 15 minutes → 429. Successful logins never consume budget, so a user
// who mistypes once is never locked out, while password spraying dies fast.
const loginFailures = createFailureTracker({
  key: 'login-fail', max: 15, windowMs: 15 * 60 * 1000,
  attributeOf: (req) => (req.body || {}).email || '',
});

function signAccessToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
}

function signRefreshToken(user, jti) {
  // jti MUST be unique per token: refresh_tokens.token is UNIQUE, and two
  // logins of the same account within the same second otherwise produce a
  // byte-identical token (HS256 is deterministic) → login 500. Random jti
  // makes every refresh token distinct.
  return jwt.sign({ id: user.id, jti: jti ?? crypto.randomUUID() }, process.env.JWT_SECRET, {
    expiresIn: `${REFRESH_TTL_DAYS}d`,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /auth/signup — capped per IP to stop mass account creation
// (generous ceiling: real deployments create a handful per hour per IP)
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
  [rateLimit({ key: 'signup', max: 100, windowMs: 60 * 60 * 1000 })],
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

    // Mobile M10 — signup collects DOB / gender / weight / height for users
    // and seeds their INTAKE PROFILE (the canonical home these fields live
    // in), so the health-profile form pre-populates and gyms can read them
    // for linked members. Optional fields, validated in the data layer.
    // Compensating delete keeps signup atomic: if the seed fails the user
    // row is removed and the client sees the error.
    const profilePayload = (req.body || {}).profile;
    if (role === 'user' && profilePayload && typeof profilePayload === 'object') {
      try {
        await intakeProfiles.seedSignupProfile(user.id, profilePayload);
      } catch (seedErr) {
        await users.deleteUser?.(user.id).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
        return res.status(seedErr.status || 400).json({ error: seedErr.message || 'Invalid profile data' });
      }
    }

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
    // brute-force guard first — a caller already over the failure budget
    // gets 429 before any DB/bcrypt work (also caps bcrypt CPU exhaustion)
    if (loginFailures.blocked(req)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    const user = await users.getUserByEmail(email);
    if (!user) {
      loginFailures.fail(req);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      loginFailures.fail(req);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
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
  [rateLimit({ key: 'refresh', max: 240, windowMs: 15 * 60 * 1000 })],
  async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    const stored = await users.findValidRefreshToken(refreshToken);
    if (!stored) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    let payload;
    try {
      // algorithms pinned: the secret is HMAC-only, so nothing else may verify
      payload = jwt.verify(refreshToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
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
registerRoute(
  router,
  {
    method: 'GET',
    path: '/me',
    description: "The authenticated account's safe profile (id, name, email, role). Used by the web portal to resolve the signed-in identity (e.g. invitation acceptance).",
    requiresAuth: true,
    allowedRoles: ['user', 'trainer', 'gym_staff'],
    category: 'Auth',
  },
  [requireAuth],
  async (req, res) => {
    try {
      const user = await users.getUserById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { password_hash, ...safeUser } = user;
      res.json(safeUser);
    } catch (e) {
      res.status(500).json({ error: e.message || 'Unexpected error' });
    }
  }
);

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
