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
const plans = require('../data/membershipPlans');
const trainers = require('../data/gymTrainers');
const billing = require('../data/gymBilling');
const storage = require('../data/storageService');
const smtpProvider = require('../email/smtpProvider');

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

// ── invitation acceptance bridge (public token routes — no gym context) ──
// Registered BEFORE '/:gymId' so 'invite' is never captured as a gym id.
// The plaintext code is the bearer token; nothing else authorizes linking.

registerRoute(router, {
  method: 'GET',
  path: '/invite/:token',
  description: 'Public invitation preview for the landing page: gym name, member name, invited email and invitation state. Requires no authentication — the one-time code itself is the credential. Returns 404 for unknown codes.',
  requiresAuth: false,
  allowedRoles: ['public'],
  category: 'Gym',
}, async (req, res) => {
  try {
    const invitation = await gyms.getInvitationByToken(req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
    res.json(invitation);
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'POST',
  path: '/invite/:token/accept',
  description: 'Scenario 1 — the person already has an app account: they sign in and accept. The account email must match the invited email exactly (identity verification); the existing User is linked to the existing GymMember, never duplicated.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await gyms.acceptInvitation(req.params.token, req.user.id, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/invite/:token/decline',
  description: 'The invited person declines. Public (the token proves possession); the invitation becomes DECLINED and the member returns to NOT_CONNECTED.',
  requiresAuth: false,
  allowedRoles: ['public'],
  category: 'Gym',
}, async (req, res) => {
  try {
    res.json(await gyms.declineInvitation(req.params.token, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
});

registerRoute(router, {
  method: 'POST',
  path: '/invite/:token/register',
  description: 'Scenario 2 — the person has NO app account: registration THROUGH the invitation. Creates the User (role user) AND links the existing GymMember atomically; fails with 409 (no partial rows) if the email is already registered — the person then signs in and accepts instead.',
  requiresAuth: false,
  allowedRoles: ['public'],
  category: 'Gym',
}, async (req, res) => {
  try {
    const { name, password } = req.body || {};
    const result = await gyms.registerViaInvitation(req.params.token, req.ip, { name, password });
    res.status(201).json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
});

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
    const gym = await gyms.getGymById(req.gymContext.gymId);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    res.json({ ...gym, profile_completion: gyms.gymProfileCompletion(gym) });
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
      status: req.query.status, connection: req.query.connection, q: req.query.q,
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

// ── gym logo (onboarding branding) ───────────────────────────────────────

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s;

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/logo',
  description: 'Uploads the gym logo (base64 PNG/JPEG/WEBP, max 2MB). Persisted before the previous logo is removed. Requires permission: settings.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')], async (req, res) => {
  try {
    const { image_base64, content_type } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
    let base64 = String(image_base64).trim();
    let contentType = content_type || null;
    const dataUrl = base64.match(DATA_URL_RE);
    if (dataUrl) {
      contentType = contentType || dataUrl[1];
      base64 = dataUrl[2];
    }
    contentType = contentType || 'image/png';
    if (!storage.GYM_LOGO_CONTENT_TYPES[contentType]) {
      return res.status(400).json({ error: 'content_type must be image/png, image/jpeg or image/webp' });
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'image_base64 is not valid base64' });
    if (buffer.length > LOGO_MAX_BYTES) {
      return res.status(400).json({ error: 'Logo exceeds the 2MB limit' });
    }
    // base64 decoders silently skip invalid characters — sniff the decoded
    // bytes so an upload that is not REALLY the claimed image type is
    // rejected rather than stored as a broken logo
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isWebp = buffer.slice(0, 4).toString('ascii') === 'RIFF'
      && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) {
      return res.status(400).json({ error: 'image_base64 does not contain a valid PNG, JPEG or WEBP image' });
    }
    const gym = await gyms.getGymById(req.gymContext.gymId);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    const stored = await storage.uploadGymLogo(buffer, gym.id, contentType);
    await gyms.setGymLogo(gym.id, req.user.id, req.ip, { logo_key: stored.key, logo_provider: stored.provider });
    // only remove the replaced file AFTER the new one persisted + row updated
    if (gym.logo_key) {
      await storage.removeGymLogo({ storage_provider: gym.logo_provider || 'local', storage_key: gym.logo_key });
    }
    res.status(201).json({ logo_key: stored.key, provider: stored.provider });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/logo',
  description: 'Streams the gym logo bytes. Any ACTIVE staff or app-linked member of this gym. 404 when no logo is set.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const gym = await gyms.getGymById(req.gymContext.gymId);
    if (!gym || !gym.logo_key) return res.status(404).json({ error: 'No logo' });
    const ext = gym.logo_key.split('.').pop();
    const contentType = Object.entries(storage.GYM_LOGO_CONTENT_TYPES)
      .find(([, e]) => e === `.${ext}`)?.[0] || 'image/png';
    const out = await storage.getGymLogoStream(
      { storage_provider: gym.logo_provider || 'local', storage_key: gym.logo_key }, contentType
    );
    if (!out) return res.status(404).json({ error: 'Logo file no longer available' });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    out.stream.pipe(res);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'DELETE',
  path: '/:gymId/logo',
  description: 'Removes the gym logo. Requires permission: settings.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')], async (req, res) => {
  try {
    const gym = await gyms.getGymById(req.gymContext.gymId);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    if (gym.logo_key) {
      await storage.removeGymLogo({ storage_provider: gym.logo_provider || 'local', storage_key: gym.logo_key });
      await gyms.setGymLogo(gym.id, req.user.id, req.ip, { logo_key: null });
    }
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')]);

// ── gym lifecycle: deactivate / reactivate / leave ───────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/deactivate',
  description: 'Owner deactivates the gym (status INACTIVE — staff and members lose access until reactivated). Requires permission: settings.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')], async (req, res) => {
  try {
    res.json(await gyms.deactivateGym(req.gymContext.gymId, req.user.id, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('settings.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/reactivate',
  description: 'Reactivates an owner-deactivated (INACTIVE) gym. Only the gym OWNER — resolved directly, since deactivated gyms fail normal gym-context resolution. Platform-suspended gyms cannot self-reactivate.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await gyms.reactivateGym(req.params.gymId, req.user.id, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/leave',
  description: 'Staff member leaves the gym voluntarily. The last active owner cannot leave (transfer ownership or deactivate first).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    if (req.gymContext.isMember) {
      return res.status(400).json({ error: 'Memberships are managed by the gym — cancellations come with membership plans' });
    }
    res.json(await gyms.leaveGym(req.gymContext.gymId, req.user.id, req.ip));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext()]);

// ── member lifecycle & app invitations ───────────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/cancel',
  description: 'Member leaves: membership → CANCELLED. The member record and history are kept; a linked app account is never touched. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.cancelGymMember(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      { reason: req.body?.reason }
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/reactivate',
  description: 'Member reactivates: membership → ACTIVE (app link untouched). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.reactivateGymMember(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/invite-app',
  description: 'Invites the member to connect an app account (NOT_CONNECTED → INVITATION_PENDING). The invite code is returned once and only stored hashed; an email is sent when SMTP is configured. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    const result = await gyms.inviteMemberApp(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip, req.body || {}
    );
    // best-effort delivery: a missing/broken SMTP never fails the invite —
    // the code is still shown in the portal for manual sharing
    if (process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
      const { getGymById } = gyms;
      const gym = await getGymById(req.gymContext.gymId);
      smtpProvider.send({
        to: result.email,
        subject: `Your invite to the ${gym ? gym.name : 'gym'} app`,
        text: `You have been invited to connect your app account to ${gym ? gym.name : 'the gym'}. ` +
          `Your invite code: ${result.invite_code}`,
        html: `<p>You have been invited to connect your app account to <b>${gym ? gym.name : 'the gym'}</b>.</p>` +
          `<p>Your invite code: <code>${result.invite_code}</code></p>`,
      }).catch((err) => {
        console.error(`[Gym] invite email failed (member=${req.params.memberId}): ${err.name || 'Error'}`);
      });
    }
    res.status(201).json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/cancel-invite',
  description: 'Withdraws a pending app invitation (INVITATION_PENDING → NOT_CONNECTED). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await gyms.cancelMemberInvite(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── membership plans (Phase 6) ───────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/plans',
  description: 'Lists membership plans (name, price, duration, access level, PT sessions, status). Requires permission: memberships.view (OWNER, ADMIN, FRONT_DESK).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')], async (req, res) => {
  try {
    res.json(await plans.listPlans(req.gymContext.gymId, { status: req.query.status }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/plans',
  description: 'Creates a membership plan (price in minor units, e.g. paise). Duplicate names within the gym are rejected. Requires permission: plans.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('plans.manage')], async (req, res) => {
  try {
    res.status(201).json(await plans.createPlan(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('plans.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/plans/:planId',
  description: 'Updates a plan (price changes never affect existing memberships — those keep their assignment-time snapshot). Archiving prevents NEW assignments only. Requires permission: plans.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('plans.manage')], async (req, res) => {
  try {
    res.json(await plans.updatePlan(
      req.gymContext.gymId, req.params.planId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('plans.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/memberships',
  description: "The member's membership history (snapshotted terms). Requires permission: memberships.view (OWNER, ADMIN, FRONT_DESK).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')], async (req, res) => {
  try {
    res.json(await plans.listMemberMemberships(req.gymContext.gymId, req.params.memberId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships',
  description: "Assigns a plan to the member (ACTIVE or ARCHIVED-plan rules apply; works with or without an app account). Set replace_active=true for a plan change — the current term is cancelled and kept in history. Requires permission: memberships.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.status(201).json(await plans.assignMembership(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/cancel',
  description: 'Cancels a membership (kept in history with reason). Requires permission: memberships.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.cancelMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/renew',
  description: "Renews a membership: snapshots the plan's CURRENT price into a new term (early renewals become UPCOMING, starting when the current term ends; expired terms become ACTIVE today). Historical terms are never modified. Requires permission: memberships.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.status(201).json(await plans.renewMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/memberships',
  description: "The gym's memberships across all members (search + status filter + offset pagination). Requires permission: memberships.view (OWNER, ADMIN, FRONT_DESK).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')], async (req, res) => {
  try {
    res.json(await plans.listGymMemberships(req.gymContext.gymId, {
      q: req.query.q, status: req.query.status,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')]);

// ── membership lifecycle (Phase 7): freeze / resume / extend / events ────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/freeze',
  description: 'Freezes an ACTIVE membership (pauses the term). On resume the expiry moves by the exact number of frozen days. Requires permission: memberships.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.freezeMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/resume',
  description: 'Resumes a frozen membership (or cancels the freeze with cancel=true). The expiry moves by the exact frozen days; the term becomes EXPIRED if it still ends before today. Requires permission: memberships.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.resumeMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/extend',
  description: 'Manually extends the term by N days (1-365). A scheduled renewal slides by the same days. Requires permission: memberships.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.extendMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/memberships/events',
  description: "The member's membership lifecycle timeline (assigned/frozen/resumed/extended/renewed/cancelled/expired). Requires permission: memberships.view (OWNER, ADMIN, FRONT_DESK).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')], async (req, res) => {
  try {
    res.json(await plans.listMembershipEvents(req.gymContext.gymId, req.params.memberId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.view')]);

// ── gym trainer assignments (Phase 8) ────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/trainers',
  description: "The gym's assignable trainers: ACTIVE staff with the TRAINER role. Requires permission: members.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await trainers.listAssignableTrainers(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/trainer/members',
  description: "The TRAINER's own roster: members currently assigned to them, with membership status. Server-filtered to the caller's staff row — a trainer can never see another trainer's members. Requires permission: assigned_members.view (TRAINER, OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('assigned_members.view')], async (req, res) => {
  try {
    const staffId = req.gymContext.gymRole === 'TRAINER'
      ? req.gymContext.staffId
      : (req.query.trainer_staff_id || req.gymContext.staffId);
    res.json(await trainers.listAssignedMembersForTrainer(req.gymContext.gymId, staffId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('assigned_members.view')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/trainer-assignments',
  description: "Gym-wide trainer assignments (optionally ?trainer_staff_id=). Requires permission: members.view or assigned_members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const c = req.gymContext;
    const allowed = c.permissions.includes('members.view') || c.permissions.includes('assigned_members.view');
    if (!allowed) return res.status(403).json({ error: 'Requires permission: members.view' });
    res.json(await trainers.listGymTrainerAssignments(c.gymId,
      { trainer_staff_id: c.gymRole === 'TRAINER' ? c.staffId : req.query.trainer_staff_id }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/trainer',
  description: "The member's trainer assignment history. Requires permission: members.view (OWNER, ADMIN, FRONT_DESK).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await trainers.listMemberTrainerAssignments(req.gymContext.gymId, req.params.memberId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/trainer',
  description: "Assigns a gym trainer to the member (works with or without an app account). Reassigning ends the previous assignment (kept as ENDED history). Requires permission: members.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.status(201).json(await trainers.assignTrainer(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/trainer/:assignmentId/end',
  description: 'Ends a trainer assignment (kept as history). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await trainers.endTrainerAssignment(
      req.gymContext.gymId, req.params.memberId, req.params.assignmentId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── billing & payment ledger (Phase 9) ───────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/payments/summary',
  description: "Billing dashboard: revenue this month, collected (net of refunds), outstanding due and overdue — computed in the gym's timezone. Requires permission: payments.manage (OWNER, ADMIN). Front desk deliberately has no access to financial reports.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    res.json(await billing.getBillingSummary(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/payments',
  description: 'Payment ledger (receipts): member, amount, date, method, membership/period, receipt number and refund-adjusted status. Search by member/receipt, filter by method and date range. Requires permission: payments.record (OWNER, ADMIN, FRONT_DESK).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')], async (req, res) => {
  try {
    res.json(await billing.listGymPayments(req.gymContext.gymId, {
      q: req.query.q, method: req.query.method, from: req.query.from, to: req.query.to,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/charges',
  description: 'Charge ledger (dues) with derived status DUE/PARTIAL/PAID/OVERDUE/REFUNDED. Requires permission: payments.record.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')], async (req, res) => {
  try {
    res.json(await billing.listChargesForLedger(req.gymContext.gymId, {
      status: req.query.status, q: req.query.q, limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/payments',
  description: "The member's charges and payment receipts. Requires permission: members.view (front desk included).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    const [charges, payments] = await Promise.all([
      billing.listMemberCharges(req.gymContext.gymId, req.params.memberId),
      billing.listMemberPayments(req.gymContext.gymId, req.params.memberId),
    ]);
    res.json({ charges, payments });
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/charges',
  description: 'Creates a charge (dues) for the member — misc dues, penalties, merch. Membership sales open charges automatically. Requires permission: payments.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    res.status(201).json(await billing.createManualCharge(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/payments',
  description: 'Records a payment (receipt) against one of the member’s charges. Works with or without an app account. Immutable once recorded; corrections happen through refunds. Duplicate receipts are rejected unless allow_duplicate=true. Future-dated payments rejected; overpayments rejected. Requires permission: payments.record (OWNER, ADMIN, FRONT_DESK).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')], async (req, res) => {
  try {
    const payment = await billing.recordPayment(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    );
    res.status(201).json(payment);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/payments/:paymentId/receipt',
  description: 'Receipt: gym name, member, plan, amount, date, method, covered period, receipt number — derived from immutable rows. Requires permission: members.view.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    const receipt = await billing.getReceipt(req.gymContext.gymId, req.params.paymentId);
    if (!receipt) return res.status(404).json({ error: 'Payment not found' });
    res.json(receipt);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/payments/:paymentId/refund',
  description: 'Records an additive refund against a payment (payments themselves are immutable). Fully refunded payments read as REFUNDED, partially refunded as PARTIAL. Requires permission: payments.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    res.status(201).json(await billing.refundPayment(
      req.gymContext.gymId, req.params.memberId, req.params.paymentId,
      { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')]);

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
