// gyms.js — ADMIN platform-level gym management (F2).
//
// Platform control over gyms WITHOUT bypassing the gym domain: reads are
// straight aggregates over the same tables the portal uses, and the only
// writes are the platform lifecycle actions (SUSPENDED ⇄ ACTIVE) — which
// the existing guard chain already enforces everywhere (resolveGymContext
// answers "This gym is suspended" to staff AND members of a SUSPENDED gym).
// Owner self-deactivation (INACTIVE) stays owner-controlled and is shown,
// not modified, here. Every write is audited (admin_audit_log).
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const { writeAudit } = require('./audit');
const { registerRoute } = require('./registry');

const router = express.Router();
router.use(requireAdmin());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(res, e) {
  console.error('[admin/gyms]', e.message);
  res.status(500).json({ error: 'Internal server error' });
}

registerRoute(router, {
  method: 'GET', path: '/gyms', category: 'Gyms',
  description: 'Platform-wide gym list with search (name/city/owner email), status filter and server-side pagination. Includes live member/lead counts and the primary owner per gym.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = ['TRUE'];
    const vals = [];
    if (req.query.q) {
      vals.push(`%${String(req.query.q).trim()}%`);
      where.push(`(g.name ILIKE $${vals.length} OR COALESCE(g.city,'') ILIKE $${vals.length}
        OR EXISTS (SELECT 1 FROM gym_staff s2 JOIN users u2 ON u2.id = s2.user_id
                   WHERE s2.gym_id = g.id AND s2.gym_role = 'OWNER' AND u2.email ILIKE $${vals.length}))`);
    }
    if (req.query.status && ['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(req.query.status)) {
      vals.push(req.query.status);
      where.push(`g.status = $${vals.length}`);
    }
    const { rows } = await query(
      `SELECT g.id, g.name, g.slug, g.status, g.city, g.timezone, g.currency,
              g.created_at,
              (SELECT count(*)::int FROM gym_members gm
                WHERE gm.gym_id = g.id AND gm.status NOT IN ('CANCELLED')) AS members,
              (SELECT count(*)::int FROM gym_leads l WHERE l.gym_id = g.id) AS leads,
              (SELECT count(*)::int FROM member_memberships t
                WHERE t.gym_id = g.id AND t.status = 'ACTIVE') AS active_memberships,
              owner.name AS owner_name, owner.email AS owner_email
       FROM gyms g
       LEFT JOIN LATERAL (
         SELECT u.name, u.email FROM gym_staff s JOIN users u ON u.id = s.user_id
         WHERE s.gym_id = g.id AND s.gym_role = 'OWNER' AND s.status = 'ACTIVE'
         ORDER BY s.created_at LIMIT 1
       ) owner ON true
       WHERE ${where.join(' AND ')}
       ORDER BY g.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      vals
    );
    const total = (await query(
      `SELECT count(*)::int AS c FROM gyms g WHERE ${where.join(' AND ')}`, vals
    )).rows[0].c;
    res.json({ total, gyms: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));

registerRoute(router, {
  method: 'GET', path: '/gyms/:id', category: 'Gyms',
  description: 'Platform-level gym detail: gym row, owner, staff roster (roles/status), and live counts (members, active memberships, leads, attendance 30d, branches, classes). Another gym\'s id is fine here — admins are platform-scoped, not tenant-scoped.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id || '')) return res.status(404).json({ error: 'Gym not found' });
    const { rows } = await query(`SELECT * FROM gyms WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Gym not found' });
    const gym = rows[0];
    const counts = (await query(`
      SELECT
        (SELECT count(*)::int FROM gym_members WHERE gym_id = $1 AND status NOT IN ('CANCELLED')) AS members,
        (SELECT count(*)::int FROM gym_members WHERE gym_id = $1 AND status = 'ACTIVE') AS members_active,
        (SELECT count(*)::int FROM member_memberships WHERE gym_id = $1 AND status = 'ACTIVE') AS memberships_active,
        (SELECT count(*)::int FROM gym_leads WHERE gym_id = $1) AS leads,
        (SELECT count(*)::int FROM gym_leads WHERE gym_id = $1 AND status = 'NEW') AS leads_new,
        (SELECT count(*)::int FROM gym_attendance WHERE gym_id = $1 AND check_in_at >= now() - interval '30 days') AS attendance_30d,
        (SELECT count(*)::int FROM gym_branches WHERE gym_id = $1 AND status = 'ACTIVE') AS branches_active,
        (SELECT count(*)::int FROM gym_classes WHERE gym_id = $1 AND status = 'SCHEDULED') AS classes_scheduled,
        (SELECT count(*)::int FROM gym_staff WHERE gym_id = $1 AND status = 'ACTIVE') AS staff_active
    `, [gym.id])).rows[0];
    const staff = (await query(`
      SELECT s.id, s.gym_role, s.status, s.created_at, u.name, u.email
      FROM gym_staff s JOIN users u ON u.id = s.user_id
      WHERE s.gym_id = $1 ORDER BY s.created_at`, [gym.id])).rows;
    res.json({ gym, counts, staff });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));


registerRoute(router, {
  method: 'GET', path: '/leads', category: 'Gyms',
  description: 'Platform-wide lead inbox across ALL gyms (read-only visibility, not gym operations — status changes stay in the Gym Portal). Filters: gym_id, status, type, q (name/phone/email), limit, offset. Each row carries its gym name.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = ['TRUE'];
    const vals = [];
    if (req.query.gym_id && UUID_RE.test(req.query.gym_id)) {
      vals.push(req.query.gym_id); where.push(`l.gym_id = $${vals.length}`);
    }
    if (req.query.status && ['NEW','CONTACTED','TRIAL_SCHEDULED','TRIAL_COMPLETED','JOINED','NOT_JOINED','NO_RESPONSE','FOLLOW_UP','CLOSED'].includes(req.query.status)) {
      vals.push(req.query.status); where.push(`l.status = $${vals.length}`);
    }
    if (req.query.type && ['ENQUIRY','TRIAL','VISITOR','MEMBERSHIP_ENQUIRY','GENERAL_ENQUIRY'].includes(req.query.type)) {
      vals.push(req.query.type); where.push(`l.enquiry_type = $${vals.length}`);
    }
    if (req.query.q) {
      vals.push(`%${String(req.query.q).trim()}%`);
      where.push(`(l.full_name ILIKE $${vals.length} OR l.phone ILIKE $${vals.length} OR COALESCE(l.email,'') ILIKE $${vals.length})`);
    }
    const { rows } = await query(
      `SELECT l.id, l.full_name, l.phone, l.email, l.enquiry_type, l.status, l.source,
              l.created_at, l.converted_member_id, g.name AS gym_name, g.id AS gym_id
       FROM gym_leads l JOIN gyms g ON g.id = l.gym_id
       WHERE ${where.join(' AND ')}
       ORDER BY l.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      vals
    );
    const total = (await query(
      `SELECT count(*)::int AS c FROM gym_leads l WHERE ${where.join(' AND ')}`, vals
    )).rows[0].c;
    res.json({ total, leads: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));


registerRoute(router, {
  method: 'GET', path: '/attendance', category: 'Gyms',
  description: 'Platform-wide attendance visibility (read-only — the check-in workflow stays in the Gym Portal). Filters: gym_id, from/to (YYYY-MM-DD, gym-local visit date), limit/offset. Rows carry member + gym names.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const where = ['TRUE'];
    const vals = [];
    if (req.query.gym_id && UUID_RE.test(req.query.gym_id)) {
      vals.push(req.query.gym_id); where.push(`a.gym_id = $${vals.length}`);
    }
    if (req.query.from && DATE_RE.test(req.query.from)) {
      vals.push(req.query.from); where.push(`a.local_date >= $${vals.length}::date`);
    }
    if (req.query.to && DATE_RE.test(req.query.to)) {
      vals.push(req.query.to); where.push(`a.local_date <= $${vals.length}::date`);
    }
    const { rows } = await query(
      `SELECT a.id, a.local_date, a.check_in_at, a.source,
              gm.first_name || ' ' || COALESCE(gm.last_name, '') AS member_name,
              gm.member_code, g.name AS gym_name, g.id AS gym_id
       FROM gym_attendance a
       JOIN gym_members gm ON gm.id = a.member_id
       JOIN gyms g ON g.id = a.gym_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.check_in_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      vals
    );
    const total = (await query(
      `SELECT count(*)::int AS c FROM gym_attendance a WHERE ${where.join(' AND ')}`, vals
    )).rows[0].c;
    res.json({ total, attendance: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));

registerRoute(router, {
  method: 'GET', path: '/memberships', category: 'Gyms',
  description: 'Platform-wide membership terms (read-only). A user account is NOT a membership: rows here are gym-scoped terms and historical states (EXPIRED/CANCELLED) are preserved, never hidden. Filters: gym_id, status, q (member name/code/plan), limit/offset.',
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = ['TRUE'];
    const vals = [];
    if (req.query.gym_id && UUID_RE.test(req.query.gym_id)) {
      vals.push(req.query.gym_id); where.push(`t.gym_id = $${vals.length}`);
    }
    if (req.query.status && ['ACTIVE','UPCOMING','FROZEN','EXPIRED','CANCELLED'].includes(req.query.status)) {
      vals.push(req.query.status); where.push(`t.status = $${vals.length}`);
    }
    if (req.query.q) {
      vals.push(`%${String(req.query.q).trim()}%`);
      where.push(`(gm.first_name ILIKE $${vals.length} OR gm.last_name ILIKE $${vals.length}
        OR gm.member_code ILIKE $${vals.length} OR t.plan_name ILIKE $${vals.length})`);
    }
    const { rows } = await query(
      `SELECT t.id, t.plan_name, t.status, t.starts_on, t.ends_on, t.price_cents, t.currency,
              t.created_at,
              gm.first_name || ' ' || COALESCE(gm.last_name, '') AS member_name,
              gm.member_code, g.name AS gym_name, g.id AS gym_id
       FROM member_memberships t
       JOIN gym_members gm ON gm.id = t.member_id
       JOIN gyms g ON g.id = t.gym_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      vals
    );
    const total = (await query(
      `SELECT count(*)::int AS c FROM member_memberships t WHERE ${where.join(' AND ')}`, vals
    )).rows[0].c;
    res.json({ total, memberships: rows });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));


registerRoute(router, {
  method: 'GET', path: '/trainers', category: 'Gyms',
  description: "Platform-wide trainer view that keeps the TWO relationship models separate: (1) gym trainers = gym_staff rows with gym_role TRAINER (their assignments live in gym_trainer_assignments and are gym-scoped), (2) independent trainer connections = trainer_clients rows (user-to-user, app-level). The app's active-trainer precedence (gym assignment first) is displayed but never modified here.",
  allowedRoles: ['analyst', 'super_admin', 'support', 'read_only'],
}, async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const gymTrainers = (await query(
      `SELECT s.id, s.status, s.created_at, u.name, u.email,
              g.name AS gym_name, g.id AS gym_id,
              (SELECT count(*)::int FROM gym_trainer_assignments a
                WHERE a.trainer_staff_id = s.id AND a.status = 'ACTIVE') AS active_assignments
       FROM gym_staff s
       JOIN users u ON u.id = s.user_id
       JOIN gyms g ON g.id = s.gym_id
       WHERE s.gym_role = 'TRAINER'
       ORDER BY s.created_at DESC
       LIMIT ${lim}`
    )).rows;
    const connections = (await query(
      `SELECT tc.id, tc.status, tc.created_at, tc.responded_at,
              tu.name AS trainer_name, tu.email AS trainer_email,
              cu.name AS client_name, cu.email AS client_email
       FROM trainer_clients tc
       JOIN users tu ON tu.id = tc.trainer_id
       JOIN users cu ON cu.id = tc.client_id
       ORDER BY tc.created_at DESC
       LIMIT ${lim}`
    )).rows;
    res.json({ gymTrainers, connections });
  } catch (e) { err(res, e); }
}, requireAdminRole('analyst', 'super_admin', 'support', 'read_only'));

// ── platform lifecycle: SUSPENDED is the admin's lever (spec: a suspended
// gym stops operating — the guard chain already 403s everything). ─────────

registerRoute(router, {
  method: 'PATCH', path: '/gyms/:id/suspend', category: 'Gyms',
  description: 'Platform-suspends a gym: gyms.status → SUSPENDED. Every gym-scoped request from its staff and members immediately answers 403 ("This gym is suspended") via resolveGymContext — no other enforcement needed. Requires reason. super_admin only.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id || '')) return res.status(404).json({ error: 'Gym not found' });
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 4) return res.status(400).json({ error: 'A reason (min 4 characters) is required' });
    const { rows } = await query(
      `UPDATE gyms SET status = 'SUSPENDED', updated_at = now()
       WHERE id = $1 AND status <> 'SUSPENDED' RETURNING id, name, status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Gym not found (or already suspended)' });
    await writeAudit(req.admin, 'gym_suspend', 'gyms', req.params.id,
      { status: 'ACTIVE' }, { status: 'SUSPENDED', reason });
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

registerRoute(router, {
  method: 'PATCH', path: '/gyms/:id/reactivate', category: 'Gyms',
  description: 'Lifts a platform suspension: gyms.status SUSPENDED → ACTIVE (owner-deactivated INACTIVE gyms stay deactivated — reactivation is the owner\'s action). super_admin only.',
  allowedRoles: ['super_admin'],
}, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id || '')) return res.status(404).json({ error: 'Gym not found' });
    const { rows } = await query(
      `UPDATE gyms SET status = 'ACTIVE', updated_at = now()
       WHERE id = $1 AND status = 'SUSPENDED' RETURNING id, name, status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Gym not found (or not suspended)' });
    await writeAudit(req.admin, 'gym_reactivate', 'gyms', req.params.id,
      { status: 'SUSPENDED' }, { status: 'ACTIVE' });
    res.json(rows[0]);
  } catch (e) { err(res, e); }
}, requireAdminRole('super_admin'));

module.exports = { router };
