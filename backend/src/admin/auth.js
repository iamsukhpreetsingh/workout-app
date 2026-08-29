// Admin auth — COMPLETELY separate from the mobile app's user auth: its own
// table, its own JWTs, its own refresh rotation. An app user's credentials
// never grant dashboard access and vice versa.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-dev-secret-change-me';
const ACCESS_TTL = '30m';
const REFRESH_TTL_DAYS = 7;

const router = express.Router();

// ── bootstrap: guarantee a super admin exists so the dashboard is usable
// on first deploy. Prints credentials once — change the password after
// first login.
async function ensureBootstrapAdmin() {
  const { rows } = await query('SELECT count(*)::int AS c FROM admin_users');
  if (rows[0].c > 0) return;
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@workout.local';
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || 'ChangeMe123!';
  const hash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO admin_users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)',
    [email, hash, 'Super Admin', 'super_admin']
  );
  // NEVER log the generated password — an operator who needs it must read
  // it from the env they set; the log only records that the account exists
  console.log(`[ADMIN] bootstrap super admin created for ${email} — change the bootstrap password immediately`);
}

function signAccess(admin) {
  return jwt.sign({ sub: admin.id, role: admin.role, admin: true }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

async function issueRefresh(adminId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query(
    `INSERT INTO admin_refresh_tokens (admin_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '${REFRESH_TTL_DAYS} days')`,
    [adminId, hash]
  );
  return raw;
}

async function adminFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.admin) return null;
    const { rows } = await query('SELECT * FROM admin_users WHERE id = $1 AND is_active', [payload.sub]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

// ── middleware: attach admin, then guard by role. Server-side enforcement
// on EVERY /admin/* route — the frontend hiding buttons is UX only.
function requireAdmin() {
  return async (req, res, next) => {
    const admin = await adminFromRequest(req);
    if (!admin) return res.status(401).json({ error: 'Admin authentication required' });
    req.admin = admin;
    next();
  };
}

const ROLE_RANK = { read_only: 0, analyst: 1, content_moderator: 2, support: 3, super_admin: 4 };

function requireAdminRole(...allowedRoles) {
  const guard = (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Admin authentication required' });
    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({ error: `Requires role: ${allowedRoles.join(' or ')}` });
    }
    next();
  };
  // marker lets registerRoute() detect a swapped (guard, handler) argument
  // order and still mount the guard BEFORE the handler
  guard.isRoleMiddleware = true;
  return guard;
}

// support+ effectively: helper used by generic browser defaults
const READ_ROLES = ['support', 'super_admin', 'content_moderator'];
const WRITE_ROLES = ['super_admin'];

// ── routes ────────────────────────────────────────────────────────────
router.post('/auth/login', express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { rows } = await query('SELECT * FROM admin_users WHERE lower(email) = lower($1)', [email || '']);
    const admin = rows[0];
    if (!admin || !admin.is_active || !(await bcrypt.compare(password || '', admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [admin.id]);
    const refresh = await issueRefresh(admin.id);
    res.json({ accessToken: signAccess(admin), refreshToken: refresh, admin: publicAdmin(admin) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/auth/refresh', express.json(), async (req, res) => {
  try {
    const raw = req.body?.refreshToken;
    if (!raw) return res.status(401).json({ error: 'refreshToken required' });
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const { rows } = await query(
      `SELECT t.*, a.* FROM admin_refresh_tokens t
       JOIN admin_users a ON a.id = t.admin_user_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [hash]
    );
    const row = rows[0];
    if (!row || !row.is_active) return res.status(401).json({ error: 'Invalid refresh token' });
    // rotate: revoke old, issue new pair
    await query('UPDATE admin_refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    const refresh = await issueRefresh(row.admin_user_id);
    res.json({
      accessToken: signAccess(row),
      refreshToken: refresh,
      admin: publicAdmin(row),
    });
  } catch (e) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.post('/auth/logout', express.json(), async (req, res) => {
  const raw = req.body?.refreshToken;
  if (raw) {
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await query('UPDATE admin_refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hash]);
  }
  res.json({ ok: true });
});

router.get('/me', requireAdmin(), (req, res) => {
  res.json(publicAdmin(req.admin));
});

// super_admin manages other admins
router.get('/admins', requireAdmin(), requireAdminRole('super_admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM admin_users ORDER BY created_at DESC');
  res.json(rows.map(publicAdmin));
});

router.post('/admins', requireAdmin(), requireAdminRole('super_admin'), express.json(), async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password || !name || !['super_admin', 'support', 'content_moderator', 'analyst', 'read_only'].includes(role)) {
      return res.status(400).json({ error: 'email, password, name and a valid role are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      'INSERT INTO admin_users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING *',
      [email, hash, name, role]
    );
    res.status(201).json(publicAdmin(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Could not create admin' });
  }
});

router.patch('/admins/:id', requireAdmin(), requireAdminRole('super_admin'), express.json(), async (req, res) => {
  try {
    const { name, role, is_active } = req.body || {};
    const { rows } = await query(
      'UPDATE admin_users SET name = COALESCE($2, name), role = COALESCE($3, role), is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING *',
      [req.params.id, name || null, role || null, typeof is_active === 'boolean' ? is_active : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Admin not found' });
    res.json(publicAdmin(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Could not update admin' });
  }
});

function publicAdmin(a) {
  return { id: a.id, email: a.email, name: a.name, role: a.role, is_active: a.is_active, created_at: a.created_at, last_login_at: a.last_login_at };
}

module.exports = { router, requireAdmin, requireAdminRole, READ_ROLES, WRITE_ROLES, adminFromRequest, ensureBootstrapAdmin, publicAdmin };
