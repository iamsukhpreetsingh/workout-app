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
const { requireGymContext, requireGymPermission, requireGymPermissionAny } = require('../middleware/gymAuth');
const { rateLimit } = require('../middleware/rateLimit');
const { query } = require('../db/pool');
const gyms = require('../data/gyms');
const plans = require('../data/membershipPlans');
const trainers = require('../data/gymTrainers');
const billing = require('../data/gymBilling');
const attendance = require('../data/gymAttendance');
const workouts = require('../data/gymWorkouts');
const nutrition = require('../data/gymNutrition');
const proofs = require('../data/gymPaymentProofs');
const contentAssignments = require('../data/gymContentAssignments');
const storage = require('../data/storageService');
const smtpProvider = require('../email/smtpProvider');

const router = express.Router();

// Phase 14 announcements (kept beside the router for a stable patch anchor)
const communications = require('../data/gymCommunications');

// Phase 15 business dashboard (same anchor strategy)
const dashboard = require('../data/gymDashboard');
// Phase 16 multi-branch
const branches = require('../data/gymBranches');
// Phase 17 class scheduling
const classes = require('../data/gymClasses');
// Phase 18 member documents & digital waivers
const documents = require('../data/gymMemberDocuments');

// SECURITY: only known HttpError business failures carry their message to
// the client. Anything unexpected (driver errors, pg casts, bugs) must NEVER
// leak internals — status is normalised (pg 22P02 bad-uuid casts → 400) and
// the message becomes generic; the detail is logged server-side instead.
const httpError = (res, e, fallback = 500) => {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message || 'Unexpected error' });
  }
  const pgBadCast = e && (e.code === '22P02' || /invalid input syntax for (type )?(uuid|integer)/.test(e.message || ''));
  console.error(e); // detail stays in the server log only
  if (pgBadCast) return res.status(400).json({ error: 'Invalid id format' });
  res.status(fallback).json({ error: fallback >= 500 ? 'Internal server error' : 'Invalid request' });
};

// ── mobile: my announcements (auth only; member resolved by JWT) ─────────
// Registered BEFORE the /:gymId routes so "/my/announcements" is never
// captured by "GET /:gymId/announcements" (route-ordering convention).
registerRoute(router, {
  method: 'GET',
  path: '/my/announcements',
  description: "The connected member's announcements across their ACTIVE gym memberships — every SENT announcement they were in the audience for, with per-channel delivery status. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await communications.listForMember(req.user.id, {
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: my classes (auth only; member resolved by JWT) ───────────────
// Registered BEFORE the /:gymId routes so "/my/classes" is never captured
// by "GET /:gymId/classes" (route-ordering convention).
registerRoute(router, {
  method: 'GET',
  path: '/my/classes',
  description: "Upcoming SCHEDULED classes across the connected member's ACTIVE gym memberships — branch-filtered to what they can access, with spots left and their own live booking status per class. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await classes.listMyClasses(req.user.id, { limit: req.query.limit }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/classes/:classId/book',
  description: 'The connected member books a class from the app. Full class → FIFO waitlist. Gates: active membership, branch access, duplicate-booking and already-over guards. Auth only (member resolved from the JWT).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.status(201).json(await classes.myBookClass(
      req.user.id, req.params.classId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/classes/:classId/cancel',
  description: "The connected member cancels their own live booking (BOOKED or WAITLISTED) for a class. Cancelling a seat promotes the earliest waitlisted member. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await classes.myCancelBooking(
      req.user.id, req.params.classId, { userId: req.user.id }, req.ip, gyms.gymAudit,
      { reason: (req.body || {}).reason }
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: my documents (auth only; member resolved by JWT) ──────────
// Phase 18: documents belong to the GymMember row — these endpoints work
// because the row carries app_user_id. A member who files paperwork at
// the desk BEFORE joining the app sees the very same documents here once
// they connect (nothing migrates — it was always theirs).
registerRoute(router, {
  method: 'GET',
  path: '/my/documents',
  description: "The connected member's documents across their ACTIVE gym memberships — waivers, agreements, ID verification, medical clearances — with live/expired/replaced state. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await documents.listMyDocuments(req.user.id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/documents/:documentId/sign',
  description: 'The connected member digitally signs a PENDING document (typed legal name → AUTHORIZED). Expired documents refuse — ask the gym for a fresh copy. Every read and signature is logged. Auth only (member resolved from the JWT).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await documents.signMyDocument(
      req.user.id, req.params.documentId,
      { actor: { userId: req.user.id, kind: 'MEMBER', label: 'MEMBER (app)' }, ip: req.ip },
      (req.body || {}), gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/documents/:documentId/file',
  description: "Streams the connected member's own live document after ownership checks (REPLACED/REVOKED copies are not served). Content-Disposition attachment; private, no-store. Every download is recorded in the document access log. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const result = await documents.streamMyDocument(
      req.user.id, req.params.documentId,
      { actor: { userId: req.user.id, kind: 'MEMBER', label: 'MEMBER (app)' }, ip: req.ip }
    );
    if (!result) return res.status(410).json({ error: 'Document file is no longer available.' });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.fileSize));
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/["\\]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    result.stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read document' });
    });
    result.stream.pipe(res);
  } catch (e) {
    httpError(res, e, e.status === 409 ? 409 : 400);
  }
}, [requireAuth]);

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
  path: '/my/attendance/workout',
  description: "The app member marks their own gym attendance after completing a workout (source WORKOUT_COMPLETION). Resolves the caller's member rows by app_user_id — no gym id from the client. Only succeeds when a membership term is ACTIVE; duplicates return the existing visit. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const memberships = await gyms.listGymMembershipsForUser(req.user.id);
    const results = [];
    for (const m of memberships.filter((x) => x.membership_status === 'ACTIVE')) {
      try {
        results.push({
          gym_id: m.gym_id, gym_name: m.gym_name,
          ...(await attendance.recordCheckIn(
            m.gym_id, m.id, 'WORKOUT_COMPLETION', { userId: req.user.id }, req.ip, {}, gyms.gymAudit
          )),
        });
      } catch (e) {
        results.push({ gym_id: m.gym_id, gym_name: m.gym_name, ok: false, reason: e.status ? e.message : 'failed' });
      }
    }
    res.json({ eligible: memberships.some((x) => x.membership_status === 'ACTIVE'), results });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/attendance/check-in',
  description: "The connected member checks in by scanning the QR poster at their gym (payload gymcheckin:v1:<code>, or the bare code). The code is the gym's rotatable 128-bit check-in secret — it IDENTIFIES the gym, it never authorizes by itself: unknown codes and suspended gyms answer 404, a gym the caller is not an app-linked member of answers 403, and the visit itself goes through the same strict eligibility + one-visit-per-day idempotency as the desk scan (source QR_CHECK_IN). Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const gym = await attendance.resolveCheckInCode((req.body || {}).code);
    if (!gym) return res.status(404).json({ error: 'Invalid check-in code — ask the front desk' });
    const memberships = await gyms.listGymMembershipsForUser(req.user.id);
    const mine = memberships.find((m) => m.gym_id === gym.id);
    if (!mine) {
      return res.status(403).json({ error: "This check-in code belongs to another gym — you're not a member there" });
    }
    const result = await attendance.recordCheckIn(
      gym.id, mine.id, 'QR_CHECK_IN', { userId: req.user.id }, req.ip, {}, gyms.gymAudit
    );
    res.status(result.duplicate ? 200 : 201).json({
      gym_id: gym.id, gym_name: gym.name,
      source: 'QR_CHECK_IN', ...result,
    });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/attendance/history',
  description: "The app member's own ✓/− calendar across their gyms, gym-local and server-dated (each row carries today = the gym's current calendar date, so the device clock is never trusted). Optional ?days= widens the window (default 90, capped at 365) so the app can render previous months. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 90, 7), 365);
    const memberships = await gyms.listGymMembershipsForUser(req.user.id);
    const out = [];
    for (const m of memberships) {
      out.push({
        gym_id: m.gym_id, gym_name: m.gym_name, member_code: m.member_code,
        today: await attendance.gymLocalToday(m.gym_id),
        history: await attendance.memberAttendanceCalendar(m.gym_id, m.id, days),
      });
    }
    res.json(out);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: my trainer (auth only; member resolved by JWT) ───────────────
// Mobile M5 member-home: the caller's ACTIVE trainer per app-linked gym,
// one row per gym with trainer fields NULL when none is assigned.
registerRoute(router, {
  method: 'GET',
  path: '/my/trainer',
  description: "The connected member's currently ACTIVE trainer per gym (name, email, assigned-since) across their app-linked memberships; trainer fields are null when the gym has not assigned one. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await trainers.listMyTrainers(req.user.id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: my billing (auth only; member resolved by JWT) ───────────────
// Mobile M5 member-home: the caller's own dues. Status/outstanding amounts
// are derived server-side (same rule as the desk ledger) — the app renders
// them, it never computes what is due or overdue.
registerRoute(router, {
  method: 'GET',
  path: '/my/billing',
  description: "The connected member's charges and dues per gym: outstanding/overdue totals, next due date and the charge rows (open dues first, then recent settled). Derived server-side from the immutable ledger; dues stay visible for frozen/expired terms. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await billing.listMyBilling(req.user.id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: payments history / receipts / online-payment action (M9) ─────
// The member can only ever READ their ledger. Amounts, statuses, receipt
// numbers and dates are computed server-side from the immutable rows —
// there is no client write path that could alter them. The online-payment
// ACTION lives here too (exposed through the backend): it is a 501 stub
// until a gateway is wired up, and the app renders whatever the server
// says instead of implementing gateway logic itself.

registerRoute(router, {
  method: 'GET',
  path: '/my/payments',
  description: "The connected member's payment history for one gym (?gym_id=): immutable receipt rows newest-first — amount, method, date, receipt number, derived status (PAID/PARTIAL/REFUNDED) and the membership/period each payment covered. Auth only (member resolved from the JWT).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    if (!req.query.gym_id) return res.status(400).json({ error: 'gym_id is required' });
    res.json(await billing.listMyPayments(req.user.id, req.query.gym_id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/receipts/:paymentId',
  description: "The connected member's own receipt: gym, member, plan, amount, date, method, covered period, receipt number and status — derived from immutable rows. Another member's receipt reads as a 404 that never confirms existence. Auth only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const receipt = await billing.getMyReceipt(req.user.id, req.params.paymentId);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/charges/:chargeId/pay-online',
  description: "The online-payment ACTION for one of the member's own charges, exposed through the backend as the spec requires. No gateway is wired up yet, so this resolves to 501 Not Implemented with a front-desk message — the shape (ownership check included) is final; a gateway later fills this handler without any app change.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.id FROM membership_charges c
       JOIN gym_members gm ON gm.id = c.member_id
       WHERE c.id = $1 AND gm.app_user_id = $2 LIMIT 1`,
      [req.params.chargeId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Charge not found' });
    res.status(501).json({
      error: 'Online payments are not available yet — please pay at the front desk.',
      online_payment_available: false,
    });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/workouts',
  description: "Everything the connected member can see across their ACTIVE gym memberships: recommended (published + flagged) and directly assigned gym workouts, plus their saved personal-library copies with an update_available hint. Members without an ACTIVE membership get nothing.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await workouts.listForMember(req.user.id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/content',
  description: "Phase 13 UNIFIED member surface: everything the connected member can see across their ACTIVE gym memberships — recommended + directly assigned gym WORKOUTS and NUTRITION in one response ({ gym_id, gym_name, workouts: { recommended, assigned }, nutrition: { recommended, assigned } }). Directly assigned rows are window-aware: SCHEDULED rows appear only from starts_on, EXPIRED rows drop off after ends_on (both carry starts_on/ends_on/notes). Recommended content additionally requires an ACTIVE membership term. Members without an ACTIVE membership get nothing.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const [w, n] = await Promise.all([
      workouts.listForMember(req.user.id),
      nutrition.listForMember(req.user.id),
    ]);
    // both aggregations use the identical membership base query — zip by gym
    const byGym = new Map();
    for (const entry of w) {
      byGym.set(entry.gym_id, { gym_id: entry.gym_id, gym_name: entry.gym_name,
        workouts: { recommended: entry.recommended, assigned: entry.assigned },
        nutrition: { recommended: [], assigned: [] } });
    }
    for (const entry of n) {
      const row = byGym.get(entry.gym_id) || { gym_id: entry.gym_id, gym_name: entry.gym_name,
        workouts: { recommended: [], assigned: [] },
        nutrition: { recommended: [], assigned: [] } };
      row.nutrition = { recommended: entry.recommended, assigned: entry.assigned };
      byGym.set(entry.gym_id, row);
    }
    res.json([...byGym.values()]);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/workouts/:workoutId/save',
  description: "Saves a gym workout to the member's personal library as a full SNAPSHOT at the current version — the copy never changes when the gym edits the original. Duplicate saves are rejected (409). Requires authentication; the member must belong to the workout's gym.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const workoutGym = await query(
      'SELECT gym_id, status FROM gym_workouts WHERE id = $1', [req.params.workoutId]
    );
    if (!workoutGym.rows.length) return res.status(404).json({ error: 'Workout not found' });
    const gymId = workoutGym.rows[0].gym_id;
    const membership = await gyms.listGymMembershipsForUser(req.user.id)
      .then((list) => list.find((m) => m.gym_id === gymId && m.status === 'ACTIVE'));
    if (!membership) return res.status(403).json({ error: 'You are not an active member of this gym' });
    const saved = await workouts.saveWorkoutForMember(
      gymId, membership.id, req.params.workoutId, { userId: req.user.id }, req.ip, gyms.gymAudit
    );
    res.status(201).json(saved);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/workouts/saved',
  description: "The member's saved personal-library copies (snapshots) with an update_available hint when the gym original has a newer version. Requires authentication.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.id AS save_id, s.saved_version, s.snapshot, s.saved_at, s.updated_at,
              w.id AS workout_id, w.title, w.version AS current_version, w.status AS workout_status,
              g.name AS gym_name
       FROM gym_workout_saves s
       JOIN gym_workouts w ON w.id = s.workout_id
       JOIN gyms g ON g.id = s.gym_id
       WHERE s.member_id IN (SELECT id FROM gym_members WHERE app_user_id = $1)
       ORDER BY s.saved_at DESC`,
      [req.user.id]
    );
    res.json(rows.rows.map((r) => ({
      ...r,
      update_available: r.workout_status === 'PUBLISHED' && r.current_version > r.saved_version,
    })));
  } catch (e) {
    console.error('[DBG saved-list]', e.stack);
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/workouts/saved/:saveId/update',
  description: 'Explicitly pulls the CURRENT gym version into the saved copy (new snapshot + saved_version). The gym can never move a member copy automatically. Requires authentication.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const memberRows = await query(
      'SELECT id, gym_id FROM gym_members WHERE app_user_id = $1', [req.user.id]
    );
    let done = null;
    for (const m of memberRows.rows) {
      try {
        done = await workouts.updateSavedWorkout(
          m.gym_id, m.id, req.params.saveId, { userId: req.user.id }, req.ip, gyms.gymAudit
        );
        break;
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }
    if (!done) return res.status(404).json({ error: 'Saved workout not found' });
    res.json(done);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'DELETE',
  path: '/my/workouts/saved/:saveId',
  description: "Removes a workout from the member's personal library. Requires authentication.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const memberRows = await query(
      'SELECT id, gym_id FROM gym_members WHERE app_user_id = $1', [req.user.id]
    );
    let done = null;
    for (const m of memberRows.rows) {
      try {
        done = await workouts.deleteSavedWorkout(
          m.gym_id, m.id, req.params.saveId, { userId: req.user.id }, req.ip, gyms.gymAudit
        );
        break;
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }
    if (!done) return res.status(404).json({ error: 'Saved workout not found' });
    res.json(done);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);


// ── mobile: gym nutrition surfaces (auth only — registered before /:gymId)

registerRoute(router, {
  method: 'GET',
  path: '/my/nutrition',
  description: "Everything the connected member can see across their ACTIVE gym memberships: recommended (published + flagged) and directly assigned gym nutrition items, plus their saved personal-library copies with an update_available hint. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await nutrition.listForMember(req.user.id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/nutrition/:itemId/save',
  description: "Saves a gym nutrition item to the member's personal library as a full SNAPSHOT at the current version — gym edits never move the copy. Duplicate saves 409. The member must hold an ACTIVE membership at the item's gym.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const itemGym = await query(
      'SELECT gym_id FROM gym_nutrition_items WHERE id = $1', [req.params.itemId]
    );
    if (!itemGym.rows.length) return res.status(404).json({ error: 'Item not found' });
    const gymId = itemGym.rows[0].gym_id;
    const membership = await gyms.listGymMembershipsForUser(req.user.id)
      .then((list) => list.find((m) => m.gym_id === gymId && m.status === 'ACTIVE'));
    if (!membership) return res.status(403).json({ error: 'You are not an active member of this gym' });
    res.status(201).json(await nutrition.saveItemForMember(
      gymId, membership.id, req.params.itemId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'GET',
  path: '/my/nutrition/saved',
  description: "The member's saved nutrition copies (snapshots) with an update_available hint. Requires authentication.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.id AS save_id, s.saved_version, s.snapshot, s.saved_at, s.updated_at,
              n.id AS item_id, n.title, n.version AS current_version, n.status AS item_status,
              g.name AS gym_name
       FROM gym_nutrition_saves s
       JOIN gym_nutrition_items n ON n.id = s.item_id
       JOIN gyms g ON g.id = s.gym_id
       WHERE s.member_id IN (SELECT id FROM gym_members WHERE app_user_id = $1)
       ORDER BY s.saved_at DESC`,
      [req.user.id]
    );
    res.json(rows.rows.map((r) => ({
      ...r,
      snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot,
      update_available: r.item_status === 'PUBLISHED' && r.current_version > r.saved_version,
    })));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/nutrition/saved/:saveId/update',
  description: 'Explicitly pulls the CURRENT gym version into the saved copy — the gym can never move a member copy automatically. Requires authentication.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const memberRows = await query(
      'SELECT id, gym_id FROM gym_members WHERE app_user_id = $1', [req.user.id]
    );
    let done = null;
    for (const m of memberRows.rows) {
      try {
        done = await nutrition.updateSavedItem(
          m.gym_id, m.id, req.params.saveId, { userId: req.user.id }, req.ip, gyms.gymAudit
        );
        break;
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }
    if (!done) return res.status(404).json({ error: 'Saved item not found' });
    res.json(done);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'DELETE',
  path: '/my/nutrition/saved/:saveId',
  description: "Removes an item from the member's personal library. Requires authentication.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    const memberRows = await query(
      'SELECT id, gym_id FROM gym_members WHERE app_user_id = $1', [req.user.id]
    );
    let done = null;
    for (const m of memberRows.rows) {
      try {
        done = await nutrition.deleteSavedItem(
          m.gym_id, m.id, req.params.saveId, { userId: req.user.id }, req.ip, gyms.gymAudit
        );
        break;
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }
    if (!done) return res.status(404).json({ error: 'Saved item not found' });
    res.json(done);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

// ── mobile: payment proofs (auth only — member resolved by JWT) ──────────

registerRoute(router, {
  method: 'GET',
  path: '/my/payment-proofs',
  description: "The connected member's submitted payment proofs (all statuses) — optionally ?gym_id=. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await proofs.listMyProofs(req.user.id, req.query.gym_id));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/payment-proofs',
  description: "Submits a payment proof (screenshot + transaction id) against one of the member's OWN outstanding charges. The backend derives ownership from the JWT, validates the amount against the outstanding balance (partial allowed, overpayment rejected), enforces one pending proof per charge and per transaction id, magic-byte-validates the <=5MB screenshot and stores it privately (S3 in production, local in dev). Status: PENDING_VERIFICATION — the due remains unpaid until an admin approves. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.status(201).json(await proofs.submitProof(req.user.id, req.ip, req.body || {}, gyms.gymAudit));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

registerRoute(router, {
  method: 'POST',
  path: '/my/payment-proofs/:proofId/cancel',
  description: "The member cancels their own PENDING_VERIFICATION proof — the due remains unpaid, no receipt is created, history is untouched. Already-processed proofs are 409. Requires authentication only.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth], async (req, res) => {
  try {
    res.json(await proofs.cancelMyProof(req.user.id, req.params.proofId, req.ip, gyms.gymAudit));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth]);

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
      branch_id: req.query.branch_id,
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
  method: 'PATCH',
  path: '/:gymId/members/:memberId/memberships/:membershipId',
  description: "Edits a SCHEDULED (UPCOMING) membership: change plan (ACTIVE plans only — price becomes that plan's current price at edit time, per the LOCKED-WHEN-SCHEDULED rule), change start/end dates (must start after the current membership ends and in the future), attach notes. The open dues charge is corrected while unpaid. The current membership and history are untouched. Requires permission: memberships.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.updateUpcomingMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/memberships/:membershipId/cancel-renewal',
  description: "Cancels a SCHEDULED (UPCOMING) renewal — deliberately different from cancelling the current membership: the future commitment and its unpaid dues charge are removed, the current membership and history are untouched, and another renewal can be scheduled later. Requires permission: memberships.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('memberships.manage')], async (req, res) => {
  try {
    res.json(await plans.cancelUpcomingMembership(
      req.gymContext.gymId, req.params.memberId, req.params.membershipId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit
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

// ── attendance (Phase 10) ────────────────────────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/attendance/scan',
  description: 'Front-desk QR scan. The token resolves to a member of THIS gym only — a QR from another gym or an invalid token answer identically (404). Enforces the idempotency rule (one visit per day / 6-hour window) and active-membership checks. Requires permission: checkin.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')], async (req, res) => {
  try {
    const { qr_token } = req.body || {};
    const member = await attendance.resolveQrToken(req.gymContext.gymId, qr_token);
    if (!member) return res.status(404).json({ error: 'Invalid QR code' });
    const result = await attendance.recordCheckIn(
      req.gymContext.gymId, member.id, 'QR_CHECK_IN', { userId: req.user.id }, req.ip,
      { note: req.body?.note, branch_id: req.body?.branch_id,
        staff_branch_ids: await branches.staffBranchIds(req.gymContext.gymId, req.user.id) },
      gyms.gymAudit
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/attendance/checkin-code',
  description: "The gym's posted QR check-in code — get-or-create (a 128-bit secret in gym settings). Print it as the poster members scan at the door; rotating it invalidates every printed copy. Requires permission: checkin.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')], async (req, res) => {
  try {
    res.json({ checkin_code: await attendance.ensureCheckInCode(req.gymContext.gymId) });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/attendance/checkin-code/rotate',
  description: 'Re-issues the posted QR check-in code (lost poster, staff change, suspected copies). Old printed codes stop working immediately; the rotation is audit-logged. Requires permission: checkin.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')], async (req, res) => {
  try {
    res.json({ checkin_code: await attendance.rotateCheckInCode(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ) });
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/attendance/offline-batch',
  description: 'Syncs a batch of check-ins queued by an OFFLINE scanner. Each item may carry qr_token or member_id and an optional client_time — future-claimed device times are corrected server-side and flagged. Per-item results; partial failures keep the rest. Requires permission: checkin.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')], async (req, res) => {
  try {
    res.json(await attendance.recordOfflineBatch(
      req.gymContext.gymId, { userId: req.user.id }, req.ip,
      { ...req.body,
        staff_branch_ids: await branches.staffBranchIds(req.gymContext.gymId, req.user.id) },
      gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/attendance',
  description: 'Front-desk manual check-in ("search Aman, mark present"). Desk discretion: non-active memberships produce a warning, not a rejection; left (cancelled) members are rejected. Requires permission: checkin.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')], async (req, res) => {
  try {
    const result = await attendance.recordCheckIn(
      req.gymContext.gymId, req.params.memberId, 'FRONT_DESK', { userId: req.user.id }, req.ip,
      { note: req.body?.note, branch_id: req.body?.branch_id,
        staff_branch_ids: await branches.staffBranchIds(req.gymContext.gymId, req.user.id) },
      gyms.gymAudit
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('checkin.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/attendance/backdate',
  description: 'Manual correction: records attendance for a PAST local day (up to 90 days back, same dedupe rule). Requires permission: attendance.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('attendance.manage')], async (req, res) => {
  try {
    res.status(201).json(await attendance.recordManual(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      { ...req.body,
        staff_branch_ids: await branches.staffBranchIds(req.gymContext.gymId, req.user.id) },
      gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('attendance.manage')]);

registerRoute(router, {
  method: 'DELETE',
  path: '/:gymId/attendance/:attendanceId',
  description: 'Manual correction: removes a wrongly-created attendance record. Requires permission: attendance.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('attendance.manage')], async (req, res) => {
  try {
    res.json(await attendance.deleteAttendance(
      req.gymContext.gymId, req.params.attendanceId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('attendance.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/attendance',
  description: "Attendance records (filter by local date and/or member). Requires permission: members.view (front desk included).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await attendance.listAttendance(req.gymContext.gymId, {
      date: req.query.date, member_id: req.query.member_id,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/attendance/stats',
  description: "Dashboard: today/week/month check-in counts, peak hours (last 30 days, gym-local), and inactive members (ACTIVE members with no visit in 14+ days). Requires permission: members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await attendance.getStats(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/attendance/history',
  description: "The member's ✓/− calendar for the last N days (default 90, gym-local days). Requires permission: members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await attendance.memberAttendanceCalendar(
      req.gymContext.gymId, req.params.memberId, Number(req.query.days) || 90
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/qr',
  description: "The member's QR token (created on first use) — the portal renders it as a QR code / printable card. Requires permission: members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await attendance.ensureQrToken(req.gymContext.gymId, req.params.memberId));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/qr/rotate',
  description: 'Re-issues the QR token (lost card / suspected copying). Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await attendance.rotateQrToken(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── mobile (app-linked member self-service) ──────────────────────────────



// ── gym workout management (Phase 11) ────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/workouts',
  description: "Lists the gym's workouts (status/q/recommended filters) with exercise/assignment/save counts. Requires permission: members.view or content.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const c = req.gymContext;
    const allowed = c.permissions.includes('members.view') || c.permissions.includes('content.manage') || c.permissions.includes('assigned_members.view');
    if (!allowed) return res.status(403).json({ error: 'Requires permission: members.view' });
    res.json(await workouts.listWorkouts(c.gymId, {
      status: req.query.status, q: req.query.q, recommended: req.query.recommended,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/workouts',
  description: 'Creates a gym-owned workout (title, description, exercises by name with sets/reps/duration, difficulty, goal, tags, status DRAFT/PUBLISHED, recommended flag). Requires permission: content.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')], async (req, res) => {
  try {
    res.status(201).json(await workouts.createWorkout(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/workouts/:workoutId',
  description: 'Full workout with its ordered exercises. Requires permission: members.view or content.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const c = req.gymContext;
    const allowed = c.permissions.includes('members.view') || c.permissions.includes('content.manage') || c.permissions.includes('assigned_members.view');
    if (!allowed) return res.status(403).json({ error: 'Requires permission: members.view' });
    const w = await workouts.getWorkout(c.gymId, req.params.workoutId);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    res.json(w);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/workouts/:workoutId',
  description: 'Updates a workout. Content edits (title/description/exercises/difficulty/goal/duration/tags) bump the VERSION — member saves keep their snapshot version. Publish/archive is a status change and does not bump. Requires permission: content.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')], async (req, res) => {
  try {
    res.json(await workouts.updateWorkout(
      req.gymContext.gymId, req.params.workoutId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/workout-assignments',
  description: 'Directly assigns a PUBLISHED gym workout to a member (works with app_user_id NULL — stored until the member connects). Phase 13: accepts optional starts_on (default: today, gym timezone), ends_on (inclusive) and notes; duplicates rejected; archived/draft workouts rejected. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.status(201).json(await workouts.assignWorkout(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/workout-assignments',
  description: "The member's workout assignment history. Requires permission: members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await workouts.listMemberWorkoutAssignments(
      req.gymContext.gymId, req.params.memberId, req.gymContext));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/workout-assignments/:assignmentId/end',
  description: 'Ends a workout assignment (kept as history). Phase 13: backed by the unified gym_content_assignments table. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await workouts.endWorkoutAssignment(
      req.gymContext.gymId, req.params.assignmentId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── Phase 13: UNIFIED content assignments (WORKOUT | NUTRITION) ─────────
// One surface for direct assignment of every gym-owned content type:
//   POST   /:gymId/assignments                          { member_id, content_type, workout_id|item_id, starts_on?, ends_on?, notes? }
//   GET    /:gymId/assignments                          gym-wide list (filters; trainer auto-scoped to roster)
//   GET    /:gymId/members/:memberId/assignments        one member's history (both types)
//   PATCH  /:gymId/assignments/:id                      edit starts_on / ends_on / notes
//   POST   /:gymId/assignments/:id/end                  end early (history kept)
// Permissions: OWNER/ADMIN via members.manage; TRAINER via assignments.manage
// AND roster scoping (may only touch members assigned to them) — enforced
// inside the data module, never the frontend.

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/assignments',
  description: "PHASE 13 — unified direct assignment of gym content (content_type WORKOUT|NUTRITION with workout_id or item_id) to a gym member. Optional starts_on (default: today in the gym's timezone), ends_on (inclusive) and notes. Non-app members are first-class (app_user_id NULL). Duplicate non-expired ACTIVE assignment → 409; assigning over an EXPIRED row supersedes it. DRAFT content → 400, ARCHIVED → 409. Trainers may only assign to members on their roster. Requires permission: members.manage (OWNER, ADMIN) or assignments.manage (TRAINER).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])], async (req, res) => {
  try {
    const b = req.body || {};
    const memberId = b.member_id;
    if (!memberId) return res.status(400).json({ error: 'member_id is required' });
    res.status(201).json(await contentAssignments.assignContent(
      req.gymContext.gymId, memberId, { userId: req.user.id }, req.ip,
      { content_type: b.content_type, workout_id: b.workout_id, item_id: b.item_id,
        starts_on: b.starts_on, ends_on: b.ends_on, notes: b.notes },
      gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/assignments',
  description: "PHASE 13 — unified assignment list with computed effective_status (SCHEDULED/ACTIVE/EXPIRED/ENDED), member + content fields, content_updated flag and trainer roster scoping. Filters: ?member_id= &content_type=WORKOUT|NUTRITION &content_id= &effective_status= &q= (member name/code or content title) &limit= &offset=. Requires permission: members.view (OWNER, ADMIN, FRONT_DESK), assignments.manage (TRAINER) or assigned_members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assignments.manage', 'assigned_members.view'])], async (req, res) => {
  try {
    res.json(await contentAssignments.listAssignments(req.gymContext.gymId, req.gymContext, {
      member_id: req.query.member_id,
      content_type: req.query.content_type,
      content_id: req.query.content_id,
      effective_status: req.query.effective_status,
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assignments.manage', 'assigned_members.view'])]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/assignments',
  description: "PHASE 13 — one member's unified assignment history across BOTH content types (ENDED included), each row with effective_status, content_updated, notes and dates. Trainers can only view members on their roster (403 otherwise). Requires permission: members.view or assignments.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assignments.manage'])], async (req, res) => {
  try {
    res.json(await contentAssignments.listMemberAssignments(
      req.gymContext.gymId, req.params.memberId,
      { content_type: req.query.content_type, ctx: req.gymContext }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assignments.manage'])]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/assignments/:assignmentId',
  description: "PHASE 13 — edits an ACTIVE assignment's starts_on / ends_on (inclusive window; ends_on >= starts_on) / notes. Physical-ENDED rows cannot be edited; extending a past ends_on revives an EXPIRED assignment. Trainers may only edit their own roster members' assignments. Requires permission: members.manage or assignments.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])], async (req, res) => {
  try {
    res.json(await contentAssignments.updateAssignment(
      req.gymContext.gymId, req.params.assignmentId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/assignments/:assignmentId/end',
  description: 'PHASE 13 — ends a unified assignment early (kept as history, end_reason + ended_on recorded; expiry by end date is automatic and needs no call). Trainers may only end their own roster members\' assignments. Requires permission: members.manage or assignments.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])], async (req, res) => {
  try {
    res.json(await contentAssignments.endAssignment(
      req.gymContext.gymId, req.params.assignmentId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.manage', 'assignments.manage'])]);

// ── mobile: connected member surfaces (auth only, member resolved by JWT) ─






// ── gym nutrition management (Phase 12) ──────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/nutrition',
  description: "Lists the gym's nutrition items (kind/status/q/recommended filters) with assignment/save counts. Requires permission: members.view or content.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext()], async (req, res) => {
  try {
    const c = req.gymContext;
    const allowed = c.permissions.includes('members.view') || c.permissions.includes('content.manage') || c.permissions.includes('assigned_members.view');
    if (!allowed) return res.status(403).json({ error: 'Requires permission: members.view' });
    res.json(await nutrition.listItems(c.gymId, {
      status: req.query.status, q: req.query.q, kind: req.query.kind, recommended: req.query.recommended,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext()]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/nutrition',
  description: 'Creates gym-owned nutrition content (kind RECIPE/MEAL_PLAN/DIET_RECOMMENDATION; content.entries lines; optional nutrition targets; tags; DRAFT/PUBLISHED; recommended flag). Requires permission: content.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')], async (req, res) => {
  try {
    res.status(201).json(await nutrition.createItem(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/nutrition/:itemId',
  description: 'Updates a nutrition item. Content edits bump the VERSION — member saves keep their snapshot. Publish/archive does not bump. Requires permission: content.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')], async (req, res) => {
  try {
    res.json(await nutrition.updateItem(
      req.gymContext.gymId, req.params.itemId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('content.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/nutrition-assignments',
  description: "Directly assigns a PUBLISHED nutrition item to a member (works with app_user_id NULL — stored until the member connects). Phase 13: accepts optional starts_on (default: today, gym timezone), ends_on (inclusive) and notes; duplicates rejected; archived/draft rejected. Requires permission: members.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.status(201).json(await nutrition.assignItem(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/nutrition-assignments',
  description: "The member's nutrition assignment history. Phase 13: backed by the unified gym_content_assignments table. Requires permission: members.view.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await nutrition.listMemberAssignments(
      req.gymContext.gymId, req.params.memberId, req.gymContext));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/nutrition-assignments/:assignmentId/end',
  description: 'Ends a nutrition assignment (kept as history). Phase 13: backed by the unified gym_content_assignments table. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await nutrition.endAssignment(
      req.gymContext.gymId, req.params.assignmentId,
      { userId: req.user.id }, req.ip, { reason: req.body?.reason }, gyms.gymAudit, req.gymContext
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

// ── payment proof verification (staff side) ──────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/payment-proofs',
  description: "Payment proofs for the gym (status filter — PENDING_VERIFICATION first for the dashboard). Requires permission: payments.record (front desk sees; approval is payments.manage).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')], async (req, res) => {
  try {
    res.json(await proofs.listGymProofs(req.gymContext.gymId, { status: req.query.status }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/payment-proofs/summary',
  description: "Pending-verification totals for the Payments dashboard card. Requires permission: payments.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    res.json(await proofs.getPendingTotals(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/payment-proofs/:proofId/screenshot',
  description: "Streams the submitted payment screenshot — gym-context authorized end to end; another gym's proof is a 404 that never confirms existence. Requires permission: payments.record.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')], async (req, res) => {
  try {
    const out = await proofs.getProofStream(req.gymContext.gymId, req.params.proofId);
    if (!out || out.notFound) return res.status(404).json({ error: 'Payment proof not found' });
    if (out.gone) return res.status(404).json({ error: 'Screenshot no longer available' });
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    out.stream.pipe(res);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.record')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/payment-proofs/:proofId/approve',
  description: "Approves a PENDING_VERIFICATION proof atomically: transactional lock + status check (double approval -> 409 'already been processed'), SUPERSEDED when the charge was settled separately, then the authoritative ledger payment via the existing recordPayment (receipt generated, idempotent) and a member notification. Requires permission: payments.manage (OWNER, ADMIN — front desk has no approval privileges).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    const actor = { userId: req.user.id, gymContext: req.gymContext };
    const result = await proofs.approveProof(req.gymContext.gymId, req.params.proofId, actor, req.ip, gyms.gymAudit);
    if (result && result.superseded) return res.status(409).json({ error: result.error });
    res.json(result);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/payment-proofs/:proofId/reject',
  description: "Rejects a PENDING_VERIFICATION proof with a required reason — the due remains DUE/OVERDUE, no payment/receipt is created, and the member is notified with the reason. Requires permission: payments.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('payments.manage')], async (req, res) => {
  try {
    const actor = { userId: req.user.id, gymContext: req.gymContext };
    res.json(await proofs.rejectProof(
      req.gymContext.gymId, req.params.proofId, actor, req.ip,
      { reason: req.body ? req.body.reason : undefined }, gyms.gymAudit
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

// ── gym announcements & fan-out (Phase 14) ───────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements',
  description: 'Creates a gym announcement (title/body, audience ALL_ACTIVE_MEMBERS | SPECIFIC_MEMBERS | SPECIFIC_BRANCH). With scheduled_for ("YYYY-MM-DD HH:mm" GYM-LOCAL wall time) it is created SCHEDULED, otherwise DRAFT. Audience resolves at SEND time. Requires permission: communications.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.status(201).json(await communications.createAnnouncement(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/announcements',
  description: "Lists the gym's announcements (status/q filters) with per-status delivery counts and the current audience size. Requires permission: communications.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.listAnnouncements(req.gymContext.gymId, {
      status: req.query.status, q: req.query.q,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/dispatch-due',
  description: 'Dispatcher trigger: promotes due SCHEDULED announcements (scheduled_for <= now) to SENT and fans out, then finishes any stranded QUEUED deliveries of already-SENT announcements. Idempotent — the per-recipient dedupe key makes double delivery impossible. Safe to tick from a cron or call manually. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.dispatchDue(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/announcements/:announcementId',
  description: 'Announcement detail with the full per-recipient delivery ledger (channel, status, detail — the honest record of what actually happened). Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.getAnnouncement(
      req.gymContext.gymId, req.params.announcementId
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/announcements/:announcementId',
  description: 'Edits a DRAFT or SCHEDULED announcement (title/body/audience; scheduled_for accepts "YYYY-MM-DD HH:mm" gym-local and promotes DRAFT → SCHEDULED). SENT and CANCELLED are immutable (409). Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.updateAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/:announcementId/publish',
  description: 'Sends a DRAFT announcement NOW: resolves the audience at send time and fans out (IN_APP inbox + PUSH with Expo token, EMAIL for non-app members when SMTP is configured). SCHEDULED ones dispatch automatically at their due time; re-publishing a SENT one is a 409. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.publishAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/:announcementId/cancel',
  description: 'Cancels a DRAFT or SCHEDULED announcement (terminal). SENT announcements cannot be cancelled — they already went out. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.cancelAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip,
      { reason: req.body?.reason }, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

// ── gym announcements & fan-out (Phase 14) ───────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements',
  description: 'Creates a gym announcement (title/body, audience ALL_ACTIVE_MEMBERS | SPECIFIC_MEMBERS | SPECIFIC_BRANCH). With scheduled_for ("YYYY-MM-DD HH:mm" GYM-LOCAL wall time) it is created SCHEDULED, otherwise DRAFT. Audience resolves at SEND time. Requires permission: communications.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.status(201).json(await communications.createAnnouncement(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/announcements',
  description: "Lists the gym's announcements (status/q filters) with per-status delivery counts and the current audience size. Requires permission: communications.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.listAnnouncements(req.gymContext.gymId, {
      status: req.query.status, q: req.query.q,
    }));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/dispatch-due',
  description: 'Dispatcher trigger: promotes due SCHEDULED announcements (scheduled_for <= now) to SENT and fans out, then finishes any stranded QUEUED deliveries of already-SENT announcements. Idempotent — the per-recipient dedupe key makes double delivery impossible. Safe to tick from a cron or call manually. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.dispatchDue(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/announcements/:announcementId',
  description: 'Announcement detail with the full per-recipient delivery ledger (channel, status, detail — the honest record of what actually happened). Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.getAnnouncement(
      req.gymContext.gymId, req.params.announcementId
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/announcements/:announcementId',
  description: 'Edits a DRAFT or SCHEDULED announcement (title/body/audience; scheduled_for accepts "YYYY-MM-DD HH:mm" gym-local and promotes DRAFT → SCHEDULED). SENT and CANCELLED are immutable (409). Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.updateAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/:announcementId/publish',
  description: 'Sends a DRAFT announcement NOW: resolves the audience at send time and fans out (IN_APP inbox + PUSH with Expo token, EMAIL for non-app members when SMTP is configured). SCHEDULED ones dispatch automatically at their due time; re-publishing a SENT one is a 409. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.publishAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/announcements/:announcementId/cancel',
  description: 'Cancels a DRAFT or SCHEDULED announcement (terminal). SENT announcements cannot be cancelled — they already went out. Requires permission: communications.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')], async (req, res) => {
  try {
    res.json(await communications.cancelAnnouncement(
      req.gymContext.gymId, req.params.announcementId, { userId: req.user.id }, req.ip,
      { reason: req.body?.reason }, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('communications.manage')]);

// ── gym management dashboard & analytics (Phase 15) ──────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/dashboard',
  description: 'Business dashboard: ONE aggregated payload over ALL gym members (app-connected or not) — member status buckets + expiring-soon, app adoption (connected / not connected / invitation pending, non-CANCELLED base), financial (net collected, month, outstanding, overdue), attendance (today / week / month on gym-local days, peak hours over 30 days, inactive 7+ days), trainer coverage (total, members per trainer, unassigned) and the per-branch split. All aggregation happens in SQL, every query gym-scoped. Requires permission: reports.view (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('reports.view')], async (req, res) => {
  try {
    res.json(await dashboard.dashboard(req.gymContext.gymId, req.query.branch_id || null));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('reports.view')]);

// ── multi-branch (Phase 16) ──────────────────────────────────────────────

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/branches',
  description: 'Branches of the gym with per-branch member counts and today\'s check-ins. Every staff role can read this (the [All Branches] selector and Front Desk need it); OWNER/ADMIN manage branches separately. Requires any of: members.view, assigned_members.view, checkin.manage, branches.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'branches.manage'])], async (req, res) => {
  try {
    res.json(await branches.listBranches(req.gymContext.gymId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'branches.manage'])]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/branches',
  description: 'Creates a branch (name, address, phone, hours, timezone, status). Requires permission: branches.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')], async (req, res) => {
  try {
    res.status(201).json(await branches.createBranch(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/branches/:branchId',
  description: 'One branch with its member count. Requires any of: members.view, assigned_members.view, checkin.manage, branches.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'branches.manage'])], async (req, res) => {
  try {
    res.json(await branches.getBranch(req.gymContext.gymId, req.params.branchId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'branches.manage'])]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/branches/:branchId',
  description: 'Updates branch details (name, address, phone, hours, timezone). A rename re-syncs the member branch labels. Requires permission: branches.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')], async (req, res) => {
  try {
    res.json(await branches.updateBranch(
      req.gymContext.gymId, req.params.branchId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/branches/:branchId/close',
  description: 'Closes a branch (status INACTIVE): NEW check-ins are blocked, history / members / staff links are preserved. Idempotent. Requires permission: branches.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')], async (req, res) => {
  try {
    res.json(await branches.setBranchStatus(
      req.gymContext.gymId, req.params.branchId, 'INACTIVE', { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/branches/:branchId/reopen',
  description: 'Reopens a closed branch (status ACTIVE). Idempotent. Requires permission: branches.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')], async (req, res) => {
  try {
    res.json(await branches.setBranchStatus(
      req.gymContext.gymId, req.params.branchId, 'ACTIVE', { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('branches.manage')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/members/:memberId/branches',
  description: "Sets a member's PRIMARY branch and ALLOWED branches (multi-club access). Access = {primary} + allowed; no primary = legacy all-branches behavior. Requires permission: members.manage (OWNER, ADMIN).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await branches.setMemberBranches(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/transfer-branch',
  description: 'Moves a member to another primary branch and records the move in the append-only transfer history. Requires permission: members.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')], async (req, res) => {
  try {
    res.json(await branches.transferMemberBranch(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/branch-history',
  description: "The member's branch transfer history (append-only). Requires permission: members.view (OWNER, ADMIN, FRONT_DESK).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')], async (req, res) => {
  try {
    res.json(await branches.memberBranchHistory(req.gymContext.gymId, req.params.memberId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('members.view')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/staff/:staffId/branches',
  description: 'Restricts a staff member to specific branches ([] = all branches). Owners always have all branches and cannot be restricted. Requires permission: staff.manage (OWNER).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')], async (req, res) => {
  try {
    res.json(await branches.setStaffBranches(
      req.gymContext.gymId, req.params.staffId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('staff.manage')]);

// ── class scheduling & bookings (Phase 17) ─────────────────────────────

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/classes',
  description: 'Creates a scheduled class instance: type, trainer, branch, room, date, start/end time, capacity. Guards: trainer must be an ACTIVE TRAINER free of overlapping classes and not restricted away from the branch; same-branch room double-booking rejected. Requires permission: classes.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')], async (req, res) => {
  try {
    res.status(201).json(await classes.createClass(
      req.gymContext.gymId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/classes',
  description: 'The schedule: classes with trainer, branch, spots left and waitlist size. Filters: from, to, status (SCHEDULED/CANCELLED/ALL), branch_id, type. Requires any of: members.view, assigned_members.view, checkin.manage, classes.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'classes.manage'])], async (req, res) => {
  try {
    res.json(await classes.listClasses(req.gymContext.gymId, {
      from: req.query.from, to: req.query.to, status: req.query.status,
      branch_id: req.query.branch_id, type: req.query.type,
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'classes.manage'])]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/classes/:classId',
  description: 'One class with its full booking sheet: every booking with member, status, source and waitlist position. Requires any of: members.view, assigned_members.view, checkin.manage, classes.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'classes.manage'])], async (req, res) => {
  try {
    res.json(await classes.getClass(req.gymContext.gymId, req.params.classId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['members.view', 'assigned_members.view', 'checkin.manage', 'classes.manage'])]);

registerRoute(router, {
  method: 'PATCH',
  path: '/:gymId/classes/:classId',
  description: 'Edits a SCHEDULED class (type, trainer, branch, room, date, times, capacity, notes). Capacity cannot drop below the seats already held; trainer/room conflicts are re-checked. Requires permission: classes.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')], async (req, res) => {
  try {
    res.json(await classes.updateClass(
      req.gymContext.gymId, req.params.classId, { userId: req.user.id }, req.ip, req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/classes/:classId/cancel',
  description: 'Cancels the class: every BOOKED/WAITLISTED booking becomes CANCELLED (reason class_cancelled); attendance rows keep history. Idempotent. Requires permission: classes.manage (OWNER, ADMIN).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')], async (req, res) => {
  try {
    res.json(await classes.cancelClass(
      req.gymContext.gymId, req.params.classId, { userId: req.user.id }, req.ip,
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('classes.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/classes/:classId/bookings',
  description: 'Front desk books a member (works for members WITHOUT an app account). Gates: active membership (expired/frozen refuse), branch access + desk restriction, duplicate 409; a full class waitlists the member (FIFO). Requires any of: checkin.manage, classes.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])], async (req, res) => {
  try {
    const memberId = (req.body || {}).member_id;
    if (!memberId) return res.status(400).json({ error: 'member_id is required' });
    res.status(201).json(await classes.bookClass(
      req.gymContext.gymId, req.params.classId, memberId,
      { source: 'DESK', actor: { userId: req.user.id }, ip: req.ip,
        staff_branch_ids: await branches.staffBranchIds(req.gymContext.gymId, req.user.id) },
      gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/classes/:classId/bookings/:bookingId/cancel',
  description: 'Cancels one booking. Cancelling a seat promotes the earliest WAITLISTED member (FIFO). Already-cancelled / attendance-recorded bookings refuse. Requires any of: checkin.manage, classes.manage.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])], async (req, res) => {
  try {
    res.json(await classes.cancelBooking(
      req.gymContext.gymId, req.params.classId, req.params.bookingId,
      { reason: (req.body || {}).reason, actor: { userId: req.user.id }, ip: req.ip },
      gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/classes/:classId/bookings/:bookingId/attendance',
  description: "Marks class attendance: ATTENDED (present), NO_SHOW (absent — frees the seat and promotes the waitlist) or BOOKED (undo a mis-mark; needs a free seat again). Requires any of: checkin.manage, classes.manage.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])], async (req, res) => {
  try {
    res.json(await classes.setAttendance(
      req.gymContext.gymId, req.params.classId, req.params.bookingId,
      (req.body || {}).attendance, { userId: req.user.id }, req.ip, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermissionAny(['checkin.manage', 'classes.manage'])]);

// ── member documents & digital waivers (Phase 18) ────────────────────────
// Documents belong to the GymMember row, so a member WITHOUT an app
// account has a full paper trail here. Staff need documents.manage
// (OWNER, ADMIN, FRONT_DESK — never TRAINER) AND their Phase 16 branch
// restriction must cover the member's home branch. Bytes stream only
// through the /file endpoints; every download is access-logged.

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/documents',
  description: 'Lists a member\'s documents (waivers, agreements, ID verification, medical clearances) with live/expired/replaced/revoked state. Retention: readable even after the member leaves. Requires permission: documents.manage (OWNER, ADMIN, FRONT_DESK) plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')], async (req, res) => {
  try {
    res.json(await documents.listMemberDocuments(
      req.gymContext.gymId, req.params.memberId, { userId: req.user.id }
    ));
  } catch (e) {
    httpError(res, e, e.status === 404 ? 404 : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/documents',
  description: 'Uploads a document for a member (works for members WITHOUT an app account). Validates size (≤8MB), MIME (PDF/PNG/JPEG), extension and magic bytes; sanitizes the filename; supersedes the previous live document of the same category. Rate-limited per IP (uploads are expensive). Requires permission: documents.manage plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage'), rateLimit({ key: 'doc-upload', max: 120, windowMs: 60 * 60 * 1000 })], async (req, res) => {
  try {
    res.status(201).json(await documents.uploadDocument(
      req.gymContext.gymId, req.params.memberId,
      { actor: { userId: req.user.id, kind: 'STAFF', label: req.gymContext.gymRole }, ip: req.ip },
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, e.status === 413 || e.status === 415 ? e.status : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage'), rateLimit({ key: 'doc-upload', max: 120, windowMs: 60 * 60 * 1000 })]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/documents/:documentId',
  description: 'One document\'s metadata plus its last 20 download-log entries (who pulled the bytes, when, from where). Requires permission: documents.manage plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')], async (req, res) => {
  try {
    res.json(await documents.getMemberDocument(
      req.gymContext.gymId, req.params.memberId, req.params.documentId, { userId: req.user.id }
    ));
  } catch (e) {
    httpError(res, e, e.status === 404 ? 404 : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')]);

registerRoute(router, {
  method: 'GET',
  path: '/:gymId/members/:memberId/documents/:documentId/file',
  description: 'THE authorized byte stream for staff. Re-checks branch scope, records the download in the document access log (actor, ip, timestamp), then streams as a private attachment. Requires permission: documents.manage plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')], async (req, res) => {
  try {
    const result = await documents.streamMemberDocument(
      req.gymContext.gymId, req.params.memberId, req.params.documentId,
      { actor: { userId: req.user.id, kind: 'STAFF', label: req.gymContext.gymRole }, ip: req.ip }
    );
    if (!result) return res.status(410).json({ error: 'Document file is no longer available.' });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.fileSize));
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/["\\]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    result.stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read document' });
    });
    result.stream.pipe(res);
  } catch (e) {
    httpError(res, e, e.status === 404 ? 404 : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/documents/:documentId/authorize',
  description: 'Records an on-paper signature at the desk: PENDING → AUTHORIZED with the typed signature name retained. Expired documents refuse — upload a fresh copy. Requires permission: documents.manage plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')], async (req, res) => {
  try {
    res.json(await documents.authorizeMemberDocument(
      req.gymContext.gymId, req.params.memberId, req.params.documentId,
      { actor: { userId: req.user.id, kind: 'STAFF', label: req.gymContext.gymRole }, ip: req.ip },
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, e.status === 404 ? 404 : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')]);

registerRoute(router, {
  method: 'POST',
  path: '/:gymId/members/:memberId/documents/:documentId/revoke',
  description: 'Withdraws a live document (wrong member, bad scan, forged file): status → REVOKED, no longer served to the member app. History is kept. Requires permission: documents.manage plus branch scope.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer', 'gym_staff'],
  category: 'Gym',
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')], async (req, res) => {
  try {
    res.json(await documents.revokeMemberDocument(
      req.gymContext.gymId, req.params.memberId, req.params.documentId,
      { actor: { userId: req.user.id, kind: 'STAFF', label: req.gymContext.gymRole }, ip: req.ip },
      req.body || {}, gyms.gymAudit
    ));
  } catch (e) {
    httpError(res, e, e.status === 404 ? 404 : 400);
  }
}, [requireAuth, requireGymContext(), requireGymPermission('documents.manage')]);

module.exports = router;
