// Self-service password reset (forgot-password flow). Public endpoints,
// hardened against enumeration and abuse:
//   - responses never reveal whether an account exists
//   - only SHA-256 hashes of reset tokens are stored; raw tokens live only
//     inside the emailed link and are never logged
//   - single-use, expiring tokens; a new request invalidates older ones
//   - successful reset revokes all refresh tokens (refresh-only session
//     invalidation; access tokens expire within their own short TTL)
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../db/pool');
const { registerRoute } = require('../admin/registry');
const { rateLimit } = require('../middleware/rateLimit');
const { sendEmail } = require('../email/provider');
const { passwordResetEmail, buildResetUrl } = require('../email/templates');
const authRoutes = require('./auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_COST = 11;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tokenExpiryMinutes() {
  const v = parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRY_MINUTES, 10);
  return Number.isFinite(v) && v > 0 && v <= 1440 ? v : 30;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Generic anti-enumeration response — identical shape regardless of
// whether the account exists or whether the email actually sent.
function genericResponse(res) {
  return res.json({
    message: 'If an account exists for this email, a password reset link has been sent.',
  });
}

// ── POST /auth/forgot-password ────────────────────────────────────────
registerRoute(
  router,
  {
    method: 'POST',
    path: '/forgot-password',
    description: 'Requests a password-reset email. Response is always generic to prevent account enumeration.',
    requiresAuth: false,
    allowedRoles: ['public'],
    category: 'Auth',
  },
  // abuse controls: per-IP burst cap plus per-email cap (attributeOf makes
  // the bucket key include the email so attackers can't lock out victims)
  [
    rateLimit({ key: 'forgot-ip', max: 10, windowMs: 60 * 60 * 1000 }),
    rateLimit({
      key: 'forgot-email',
      max: 3,
      windowMs: 60 * 60 * 1000,
      attributeOf: (req) => req.body?.email,
    }),
  ],
  async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Please enter your email address.' });
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }

      const user = await query(
        'SELECT id FROM users WHERE email = $1 AND is_suspended = false',
        [email]
      );

      if (!user.rows.length) return genericResponse(res); // indistinguishable

      const userId = user.rows[0].id;
      const rawToken = crypto.randomBytes(32).toString('hex'); // 256-bit
      const minutes = tokenExpiryMinutes();

      await transaction(async (client) => {
        // newest request wins: kill any still-outstanding tokens first
        await client.query(
          `UPDATE password_reset_tokens SET expires_at = now()
           WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
          [userId]
        );
        await client.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
           VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5)`,
          [
            userId,
            sha256(rawToken),
            String(minutes),
            req.headers['x-forwarded-for']?.split(',')[0]?.trim()?.slice(0, 64) || null,
            String(req.headers['user-agent'] || '').slice(0, 200) || null,
          ]
        );
        // opportunistic cleanup — expired/used rows have no further purpose
        await client.query(
          `DELETE FROM password_reset_tokens WHERE user_id = $1 AND (expires_at <= now() OR used_at IS NOT NULL)`,
          [userId]
        );
      });

      const resetUrl = buildResetUrl(rawToken);
      const { subject, html, text } = passwordResetEmail({
        resetUrl,
        expiresInMinutes: minutes,
      });

      try {
        await sendEmail({ to: email, subject, html, text });
      } catch (mailErr) {
        // infrastructure failure: log diagnostics WITHOUT secrets or tokens,
        // keep the external response identical so existence isn't revealed
        console.error('[PASSWORD_RESET] email delivery failed:', mailErr.message);
      }

      return genericResponse(res);
    } catch (e) {
      console.error('[PASSWORD_RESET] forgot-password error:', e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
);

// ── POST /auth/reset-password ─────────────────────────────────────────
registerRoute(
  router,
  {
    method: 'POST',
    path: '/reset-password',
    description: 'Consumes a single-use reset token and sets a new password, revoking all existing sessions (refresh tokens).',
    requiresAuth: false,
    allowedRoles: ['public'],
    category: 'Auth',
  },
  rateLimit({ key: 'reset-ip', max: 20, windowMs: 60 * 60 * 1000 }),
  async (req, res) => {
    try {
      const rawToken = String(req.body?.token || '').trim();
      const password = String(req.body?.password || '');

      if (!rawToken) return res.status(400).json({ error: 'Invalid password reset link.' });
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // format gate: real tokens are 64 hex chars — anything else can't
      // exist in the table, reject before touching the database
      if (!/^[0-9a-f]{64}$/.test(rawToken)) {
        return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
      }

      const tokenHash = sha256(rawToken);
      const { rows } = await query(
        `SELECT t.id, t.user_id, t.expires_at, t.used_at
         FROM password_reset_tokens t WHERE t.token_hash = $1`,
        [tokenHash]
      );
      const record = rows[0];

      if (!record) {
        return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });
      }
      if (record.used_at) {
        return res.status(400).json({
          error: 'This password reset link has already been used. Please request a new one if you need to change your password again.',
        });
      }
      if (new Date(record.expires_at) <= new Date()) {
        return res.status(400).json({
          error: 'This password reset link has expired. Please request a new password reset link.',
        });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

      await transaction(async (client) => {
        const upd = await client.query(
          `UPDATE password_reset_tokens SET used_at = now()
           WHERE id = $1 AND used_at IS NULL AND expires_at > now()`,
          [record.id]
        );
        if (!upd.rowCount) throw Object.assign(new Error('token_consumed'), { status: 400 });

        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
          passwordHash,
          record.user_id,
        ]);

        // invalidate any OTHER outstanding tokens for this user too
        await client.query(
          `UPDATE password_reset_tokens SET expires_at = now()
           WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
          [record.user_id]
        );

        // refresh-only session invalidation: every device must re-login.
        // Access tokens remain valid until their own ≤30m TTL by design.
        await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [record.user_id]);
      });

      res.json({ ok: true, message: 'Password updated successfully.' });
    } catch (e) {
      if (e.message === 'token_consumed') {
        return res.status(400).json({ error: 'This password reset link has already been used.' });
      }
      console.error('[PASSWORD_RESET] reset-password error:', e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
);

// ── POST /auth/change-password (logged-in users; Settings screen) ─────
registerRoute(
  router,
  {
    method: 'POST',
    path: '/change-password',
    description: 'Authenticated password change: verifies the current password, updates it, revokes all sessions and returns fresh tokens for THIS device.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Auth',
  },
  async (req, res) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');
      if (!currentPassword) return res.status(400).json({ error: 'Enter your current password' });
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // full row needed for the hash
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Account not found' });

      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

      // rotate: new password + all old refresh tokens die; a fresh pair is
      // issued so THIS device stays signed in while every other device is
      // logged out. Access tokens on other devices expire within their TTL.
      const accessToken = authRoutes.signAccessToken(user);
      const refreshToken = authRoutes.signRefreshToken(user, crypto.randomUUID());
      const expiresAt = new Date(Date.now() + authRoutes.REFRESH_TTL_DAYS * 86400 * 1000);

      await transaction(async (client) => {
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
          passwordHash,
          req.user.id,
        ]);
        await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.user.id]);
        await client.query(
          `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
          [req.user.id, refreshToken, expiresAt]
        );
      });

      res.json({
        ok: true,
        message: 'Password updated.',
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      });
    } catch (e) {
      console.error('[PASSWORD_RESET] change-password error:', e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  },
  [
    requireAuth,
    rateLimit({ key: 'chgpw', max: 10, windowMs: 60 * 60 * 1000 }),
  ]
);

module.exports = router;
