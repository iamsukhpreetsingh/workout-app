// routes/gym.js — Gym Management surface (Phase 1: auth, authz, RBAC).
//
// Guard chain for every gym-scoped route (order matters):
//   requireAuth                       → who is the caller (from JWT)
//   requireGymContext()               → verified gym_staff / gym_member row
//                                       for :gymId (or X-Gym-Id), attached as
//                                       req.gymContext
//   requireGymPermission('…')         → the caller's GYM-SCOPED role must hold
//                                       the permission (gymPermissions matrix)
// gymId / role / member ids from the frontend are selectors, never proof.
const express = require('express');
const { registerRoute } = require('../admin/registry');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireGymContext, requireGymPermission } = require('../middleware/gymAuth');
const gyms = require('../data/gyms');

const router = express.Router();

const httpError = (res, e, fallback = 500) => {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
};

// ── gym creation & discovery (no gym context yet) ────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/',
  description: 'Creates a gym. The caller becomes its OWNER (gym_staff row) and, if they were a plain app user, their global role upgrades to gym_staff. A trainer keeps the trainer role.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])], async (req, res) => {
  try {
    const result = await gyms.createGym(req.user.id, req.ip, req.body || {});
    res.status(201).json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])]);

registerRoute(router, {
  method: 'GET',
  path: '/mine',
  description: 'Gyms where the caller is ACTIVE staff (id, name, gym-scoped role). Drives the web portal gym picker and the route guard.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])], async (req, res) => {
  try {
    res.json(await gyms.listGymsForStaff(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])]);

registerRoute(router, {
  method: 'GET',
  path: '/my/memberships',
  description: "Gyms where the caller is an app-linked MEMBER (gym_members rows by app_user_id) — the member-facing 'my gym' data source.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])], async (req, res) => {
  try {
    res.json(await gyms.listGymMembershipsForUser(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole(['user', 'trainer', 'gym_staff'])]);

// ── gym settings ─────────────────────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId',
  description: 'Gym details. Any ACTIVE staff or ACTIVE app-linked member of this gym.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    res.json(await gyms.getGymById(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId',
  description: 'Updates gym settings. Requires permission: settings.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')], async (req, res) => {
  try {
    res.json(await gyms.updateGym(req.gymContext.gymId, req.user.id, req.body || {}, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')]);

// ── staff management ─────────────────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/staff',
  description: 'Lists gym staff. Requires permission: staff.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')], async (req, res) => {
  try {
    res.json(await gyms.listGymStaff(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/staff',
  description: 'Adds staff by email (the person must already have an app account). Requires permission: staff.manage (OWNER). Re-hires previously removed staff.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')], async (req, res) => {
  try {
    res.status(201).json(await gyms.addGymStaff(
      req.gymContext.gymId, req.user.id, req.ip, req.body || {}
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/staff/:staffId',
  description: "Changes a staff member's role/status. The last active owner can never be demoted or removed. Requires permission: staff.manage (OWNER).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')], async (req, res) => {
  try {
    res.json(await gyms.updateGymStaff(
      req.gymContext.gymId, req.params.staffId, req.user.id, req.ip, req.body || {}
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')]);

// ── members ──────────────────────────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members',
  description: 'Lists/searches gym members. Requires permission: members.view (OWNER, ADMIN, FRONT_DESK). TRAINER members are limited to assigned members (assignments land in a later phase).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await gyms.listGymMembers(req.gymContext.gymId, {
      status: req.query.status, q: req.query.q,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members',
  description: 'Creates a gym member. No app account is required. Requires permission: members.create (OWNER, ADMIN, FRONT_DESK).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.create')], async (req, res) => {
  try {
    res.status(201).json(await gyms.createGymMember(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.create')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId',
  description: 'Member detail. Requires permission: members.view (OWNER, ADMIN, FRONT_DESK).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    const member = await gyms.getGymMember(req.gymContext.gymId, req.params.memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json(member);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/members/:memberId',
  description: 'Updates a member (contact, status, notes). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.updateGymMember(
      req.gymContext.gymId, req.params.memberId,
      { userId: req.user.id }, req.ip, req.body || {}
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── app-account linking ──────────────────────────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/link-app',
  description: 'Links an existing member to an app account by EXACT email match (never duplicates the member or the user). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.linkMemberToApp(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip, req.body || {}
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/unlink-app',
  description: 'Unlinks the member from their app account (history retained). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.unlinkMemberFromApp(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── audit log ────────────────────────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/audit-log',
  description: 'Gym audit trail (append-only). Requires permission: audit.view (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('audit.view')], async (req, res) => {
  try {
    res.json(await gyms.listAuditLog(req.gymContext.gymId, {
      limit: req.query.limit, offset: req.query.offset, action: req.query.action,
    }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('audit.view')]);

// ── caller permissions (frontend route-guard data source) ────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/permissions',
  description: "The caller's resolved gym context for this gym: gym-scoped role + permission list. This is what the web portal's route guards consume.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const c = req.gymContext;
    res.json({
      gymId: c.gymId, gymName: c.gymName, gymRole: c.gymRole,
      isMember: c.isMember, permissions: c.permissions,
    });
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext()]);

module.exports = router;
