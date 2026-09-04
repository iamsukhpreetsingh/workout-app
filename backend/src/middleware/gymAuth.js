// gymAuth.js — gym context resolution + authorization middleware.
//
// SECURITY RULE: the frontend never proves authorization. gymId, role and
// membership are resolved HERE from the authenticated user:
//   authenticated user → gym_staff / gym_members rows → gym → role → guards
// A staff/member of gym A requesting gym B resources gets 403 — the gym id
// from the URL or X-Gym-Id header is only a selector, never proof.
//
// Staff (gym_staff) and app-linked members (gym_members) resolve through
// separate paths and are never confused with each other or with the global
// trainer-client relationship (trainer_clients).
const { query } = require('../db/pool');
const { GYM_PERMISSIONS } = require('../data/gymPermissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the caller's relationship to a gym: staff row, member row, or null.
async function resolveGymContext(userId, gymId) {
  const staff = await query(
    `SELECT s.id AS staff_id, s.gym_role, s.status AS staff_status,
            g.name AS gym_name, g.status AS gym_status
     FROM gym_staff s JOIN gyms g ON g.id = s.gym_id
     WHERE s.user_id = $1 AND s.gym_id = $2`,
    [userId, gymId]
  );
  if (staff.rows[0]) {
    const s = staff.rows[0];
    if (s.gym_status !== 'ACTIVE') return { error: 403, message: 'This gym is suspended' };
    if (s.staff_status !== 'ACTIVE') return { error: 403, message: 'Your staff access to this gym is not active' };
    return {
      gymId, staffId: s.staff_id, gymRole: s.gym_role,
      gymName: s.gym_name, isMember: false,
      permissions: GYM_PERMISSIONS[s.gym_role] || [],
    };
  }

  // app-linked member (non-app members have no login, so they never resolve here)
  const member = await query(
    `SELECT m.id AS member_row_id, m.status AS member_status,
            g.name AS gym_name, g.status AS gym_status
     FROM gym_members m JOIN gyms g ON g.id = m.gym_id
     WHERE m.app_user_id = $1 AND m.gym_id = $2`,
    [userId, gymId]
  );
  if (member.rows[0]) {
    const m = member.rows[0];
    if (m.gym_status !== 'ACTIVE') return { error: 403, message: 'This gym is suspended' };
    if (m.member_status !== 'ACTIVE') return { error: 403, message: 'Your membership is not active' };
    return {
      gymId, memberRowId: m.member_row_id, gymRole: 'MEMBER',
      gymName: m.gym_name, isMember: true,
      permissions: GYM_PERMISSIONS.MEMBER,
    };
  }

  return null; // no relationship with this gym
}

// Middleware factory: resolves the gym context from :gymId or X-Gym-Id and
// attaches req.gymContext = { gymId, gymRole, permissions, ... }.
function requireGymContext() {
  return async (req, res, next) => {
    try {
      const gymId = req.params.gymId || req.headers['x-gym-id'];
      if (!gymId) {
        return res.status(400).json({ error: 'gym context required (path :gymId or X-Gym-Id header)' });
      }
      if (!UUID_RE.test(gymId)) {
        return res.status(400).json({ error: 'invalid gym id' });
      }
      const ctx = await resolveGymContext(req.user.id, gymId);
      if (!ctx) {
        // deliberately identical for "no relationship" and "removed/inactive" —
        // never confirm the existence of another gym's resources
        return res.status(403).json({ error: 'You do not have access to this gym' });
      }
      if (ctx.error) return res.status(ctx.error).json({ error: ctx.message });
      req.gymContext = ctx;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// Middleware factory: the resolved gym role must hold this permission.
function requireGymPermission(permission) {
  return (req, res, next) => {
    const ctx = req.gymContext;
    if (!ctx) return res.status(500).json({ error: 'gym context missing — mount requireGymContext first' });
    if (!(ctx.permissions || []).includes(permission)) {
      return res.status(403).json({ error: `Requires permission: ${permission}` });
    }
    next();
  };
}

// Middleware factory: the resolved gym role must hold AT LEAST ONE of these
// permissions (anyOf semantics, mirrors the web portal's hasPermission).
function requireGymPermissionAny(permissions) {
  return (req, res, next) => {
    const ctx = req.gymContext;
    if (!ctx) return res.status(500).json({ error: 'gym context missing — mount requireGymContext first' });
    const held = (permissions || []).some((p) => (ctx.permissions || []).includes(p));
    if (!held) return res.status(403).json({ error: `Requires permission: ${(permissions || []).join(' or ')}` });
    next();
  };
}

module.exports = { resolveGymContext, requireGymContext, requireGymPermission, requireGymPermissionAny };
