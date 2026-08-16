const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../data/users');

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
router.post('/signup', async (req, res, next) => {
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
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await users.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
    await users.storeRefreshToken(user.id, refreshToken, expiresAt);

    // never leak password_hash
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, accessToken, refreshToken });
  } catch (e) {
    next(e);
  }
});

// POST /auth/refresh — one refresh token → new access token (+ rotation)
router.post('/refresh', async (req, res, next) => {
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
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) await users.revokeRefreshToken(refreshToken);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
