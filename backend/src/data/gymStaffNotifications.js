// gymStaffNotifications.js — the STAFF-facing notification stream (gym-web
// Notification Center). Deliberately separate from the member-facing
// `notifications` table (notifications.js): different audience, different
// lifecycle, different rules.
//
// Architecture (one funnel, never scattered recipient logic):
//   business event → notifyStaff()
//     → type registry (category/severity/permission)
//     → recipient resolution (ACTIVE staff of THIS gym only)
//     → permission filter (a notification for a resource the recipient
//       cannot access is NOT sent — spec rule)
//     → self-action suppression (the actor never notifies themselves)
//     → dedupe (unique dedupe_key — retries and repeated scans never double)
//     → INSERT per recipient (rows are always personal, never broadcast)
//
// NEVER throw into the caller: every entry point is fire-and-forget safe —
// a notification failure must not roll back the business operation.
// Recipients are resolved from CURRENT roles at send time; opening the
// underlying resource re-checks authorization through the normal guard
// chain (a notification is never credentials).
const { query, pool } = require('../db/pool');
const { hasPermission } = require('./gymPermissions');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── type registry: ONE place that knows every notification type ──────────
// category  → portal filter groups
// severity  → visual treatment (INFO/SUCCESS/WARNING/CRITICAL)
// permission → who may KNOW about this event (checked against the CURRENT
//              gym role at send time; recipients without it get nothing)
// selfSuppressed: the actor who CAUSED the event never receives it
const TYPES = {
  // member lifecycle
  MEMBER_JOINED:            { category: 'MEMBER', severity: 'INFO', permission: 'members.view' },
  MEMBER_APP_CONNECTED:     { category: 'MEMBER', severity: 'INFO', permission: 'members.view' },
  MEMBER_LEFT:              { category: 'MEMBER', severity: 'INFO', permission: 'members.view' },
  MEMBER_ARCHIVED:          { category: 'MEMBER', severity: 'INFO', permission: 'members.view' },
  MEMBER_REJOINED:          { category: 'MEMBER', severity: 'INFO', permission: 'members.view' },
  // membership lifecycle
  MEMBERSHIP_ASSIGNED:      { category: 'MEMBERSHIP', severity: 'INFO', permission: 'memberships.view' },
  MEMBERSHIP_RENEWED:       { category: 'MEMBERSHIP', severity: 'INFO', permission: 'memberships.view' },
  MEMBERSHIP_FROZEN:        { category: 'MEMBERSHIP', severity: 'INFO', permission: 'memberships.view' },
  MEMBERSHIP_RESUMED:       { category: 'MEMBERSHIP', severity: 'INFO', permission: 'memberships.view' },
  MEMBERSHIP_CANCELLED:     { category: 'MEMBERSHIP', severity: 'WARNING', permission: 'memberships.view' },
  MEMBERSHIP_EXPIRING:      { category: 'MEMBERSHIP', severity: 'WARNING', permission: 'memberships.view' },
  MEMBERSHIP_EXPIRED:       { category: 'MEMBERSHIP', severity: 'WARNING', permission: 'memberships.view' },
  // payments
  PAYMENT_PROOF_SUBMITTED:  { category: 'PAYMENT', severity: 'WARNING', permission: 'payments.manage' },
  PAYMENT_PROOF_CANCELLED:  { category: 'PAYMENT', severity: 'INFO', permission: 'payments.manage' },
  PAYMENT_PROOF_APPROVED:   { category: 'PAYMENT', severity: 'SUCCESS', permission: 'payments.record', selfSuppressed: true },
  PAYMENT_PROOF_REJECTED:   { category: 'PAYMENT', severity: 'INFO', permission: 'payments.record', selfSuppressed: true },
  PAYMENT_RECORDED:         { category: 'PAYMENT', severity: 'INFO', permission: 'payments.record', selfSuppressed: true },
  PAYMENT_REFUNDED:         { category: 'PAYMENT', severity: 'WARNING', permission: 'payments.record', selfSuppressed: true },
  PAYMENT_OVERDUE:          { category: 'PAYMENT', severity: 'WARNING', permission: 'payments.record' },
  // attendance
  MEMBER_INACTIVE:          { category: 'ATTENDANCE', severity: 'WARNING', permission: 'members.view' },
  // trainer
  TRAINER_ASSIGNED:         { category: 'TRAINER', severity: 'INFO', permission: 'members.manage' },
  TRAINER_UNASSIGNED:       { category: 'TRAINER', severity: 'INFO', permission: 'members.manage' },
  // content
  WORKOUT_ASSIGNED:         { category: 'WORKOUT', severity: 'INFO', permission: 'assigned_members.view' },
  NUTRITION_ASSIGNED:       { category: 'NUTRITION', severity: 'INFO', permission: 'assigned_members.view' },
  // classes
  CLASS_BOOKED:             { category: 'CLASS', severity: 'INFO', permission: 'classes.manage' },
  CLASS_CANCELLED:          { category: 'CLASS', severity: 'WARNING', permission: 'classes.manage' },
  // documents
  DOCUMENT_SIGNED:          { category: 'DOCUMENT', severity: 'INFO', permission: 'documents.manage' },
  // leads (public QR enquiries)
  LEAD_RECEIVED:            { category: 'LEAD', severity: 'INFO', permission: 'leads.view' },
  // staff/system/security
  STAFF_INVITATION_ACCEPTED:{ category: 'SYSTEM', severity: 'INFO', permission: 'staff.manage' },
  STAFF_ROLE_CHANGED:       { category: 'SECURITY', severity: 'CRITICAL', permission: 'staff.manage', selfSuppressed: true },
};

const CATEGORIES = [...new Set(Object.values(TYPES).map((t) => t.category))];
const SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL'];

function typeDef(type) {
  const def = TYPES[type];
  if (!def) throw new HttpError(500, `Unknown staff notification type: ${type}`);
  return def;
}

// ── core: create the notifications for one business event ────────────────
// Accepts an optional db `client` — when given, the rows join the caller's
// transaction (atomic with the event); otherwise a pool query fires.
async function insertForEvent(client, event) {
  const {
    gymId, type, title, message,
    entityType = null, entityId = null, memberId = null,
    actorUserId = null, dedupeKey = null, metadata = {},
  } = event;
  const def = typeDef(type);
  const db = client || pool;

  // recipients: CURRENT active staff of THIS gym whose CURRENT role holds
  // the type's permission — never a snapshot from when something was created
  const { rows: staff } = await db.query(
    `SELECT s.user_id, s.gym_role
     FROM gym_staff s
     WHERE s.gym_id = $1 AND s.status = 'ACTIVE'`,
    [gymId]
  );
  const recipients = staff
    .filter((s) => hasPermission(s.gym_role, def.permission))
    .map((s) => s.user_id)
    .filter((uid) => !def.selfSuppressed || !actorUserId || uid !== actorUserId);
  if (!recipients.length) return [];

  const rows = await db.query(
    `INSERT INTO gym_staff_notifications
       (gym_id, recipient_user_id, type, category, severity, title, message,
        entity_type, entity_id, member_id, dedupe_key, metadata)
     SELECT $1, uid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     FROM unnest($2::uuid[]) AS uid
     ON CONFLICT (dedupe_key, recipient_user_id) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [gymId, recipients, type, def.category, def.severity, title, message,
     entityType, entityId, memberId, dedupeKey, JSON.stringify(metadata || {})]
  );
  return rows.rows;
}

// fire-and-forget entry point used by business code — NEVER throws
function notifyStaff(event, client = null) {
  insertForEvent(client, event).catch((e) =>
    console.error(`[StaffNotifications] ${event.type} failed: ${e.message}`));
  // when a transaction client is provided the insert joins that txn — the
  // caller owns its failure; the catch only guards the resolution queries
}

// ── inbox (recipient-scoped; the gym id comes from requireGymContext) ────
const SELECT_COLS = `id, type, category, severity, title, message,
    entity_type, entity_id, member_id, is_read, read_at, created_at, metadata, dedupe_key`;

async function listForUser(userId, gymId, { unread, category, severity, member_id, q, limit = 25, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = ['recipient_user_id = $1', 'gym_id = $2'];
  const vals = [userId, gymId];
  if (unread) { vals.push(true); where.push(`is_read = $${vals.length}`); }
  if (category && CATEGORIES.includes(category)) {
    vals.push(category); where.push(`category = $${vals.length}`);
  }
  if (severity && SEVERITIES.includes(severity)) {
    vals.push(severity); where.push(`severity = $${vals.length}`);
  }
  if (member_id) { vals.push(member_id); where.push(`member_id = $${vals.length}`); }
  if (q) {
    vals.push(`%${String(q).trim()}%`);
    where.push(`(title ILIKE $${vals.length} OR message ILIKE $${vals.length})`);
  }
  const { rows } = await query(
    `SELECT ${SELECT_COLS},
            (SELECT NULLIF(btrim(gm.first_name || ' ' || COALESCE(gm.last_name, '')), '')
               FROM gym_members gm WHERE gm.id = gym_staff_notifications.member_id)
              AS member_name,
            (SELECT gm.member_code FROM gym_members gm WHERE gm.id = gym_staff_notifications.member_id)
              AS member_code
     FROM gym_staff_notifications
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${lim} OFFSET ${off}`,
    vals
  );
  return rows;
}

async function unreadCount(userId, gymId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM gym_staff_notifications
     WHERE recipient_user_id = $1 AND gym_id = $2 AND is_read = FALSE`,
    [userId, gymId]
  );
  return rows[0].c;
}

async function getForUser(userId, gymId, id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLS} FROM gym_staff_notifications
     WHERE id = $1 AND recipient_user_id = $2 AND gym_id = $3`,
    [id, userId, gymId]
  );
  return rows[0] || null;
}

async function markRead(userId, gymId, ids) {
  const clean = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string');
  if (!clean.length) return 0;
  const { rows } = await query(
    `UPDATE gym_staff_notifications SET is_read = TRUE, read_at = now()
     WHERE recipient_user_id = $1 AND gym_id = $2 AND id = ANY($3::uuid[]) AND is_read = FALSE
     RETURNING id`,
    [userId, gymId, clean]
  );
  return rows.length;
}

async function markAllRead(userId, gymId) {
  const { rows } = await query(
    `UPDATE gym_staff_notifications SET is_read = TRUE, read_at = now()
     WHERE recipient_user_id = $1 AND gym_id = $2 AND is_read = FALSE
     RETURNING id`,
    [userId, gymId]
  );
  return rows.length;
}

// ── lazy scan: the "background job" ──────────────────────────────────────
// This app has NO cron (everything lazy — see runMembershipMaintenance).
// Scanning runs when staff open the Notification Center, is bounded to one
// gym, and every notification it can produce carries a date-scoped
// dedupe_key, so running it 100×/day creates each alert exactly once.
// Thresholds come from the gym's settings JSONB (staff_notifications key),
// defaulting to: expiry warning 3 days ahead, inactivity 14 days.
async function runStaffNotificationScan(gymId) {
  const { rows: gymRows } = await query(
    `SELECT timezone, COALESCE(settings->'staff_notifications', '{}'::jsonb) AS prefs
     FROM gyms WHERE id = $1`,
    [gymId]
  );
  if (!gymRows.length) return { created: 0 };
  const tz = gymRows[0].timezone || 'UTC';
  const expireInDays = Number(gymRows[0].prefs?.membership_expiring_days) || 3;
  const inactiveDays = Number(gymRows[0].prefs?.member_inactive_days) || 14;

  let created = 0;
  const todayIso = (await query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0].d;

  // 1. memberships expiring within N days (ACTIVE terms only)
  const { rows: expiring } = await query(
    `SELECT t.id, t.plan_name, t.ends_on, gm.first_name, gm.last_name, gm.id AS member_id
     FROM member_memberships t JOIN gym_members gm ON gm.id = t.member_id
     WHERE gm.gym_id = $1 AND t.status = 'ACTIVE'
       AND t.ends_on >= $2::date
       AND t.ends_on <= ($2::date + ($3 || ' days')::interval)`,
    [gymId, todayIso, expireInDays]
  );
  for (const t of expiring) {
    const name = [t.first_name, t.last_name].filter(Boolean).join(' ');
    const days = Math.round((new Date(t.ends_on) - new Date(todayIso)) / 86400000);
    const r = await insertForEvent(null, {
      gymId, type: 'MEMBERSHIP_EXPIRING',
      title: 'Membership expiring',
      message: `${name}'s ${t.plan_name} membership expires in ${days} day${days === 1 ? '' : 's'}.`,
      entityType: 'MEMBERSHIP', entityId: t.id, memberId: t.member_id,
      dedupeKey: `membership_expiring:${t.id}:${t.ends_on}`,
      metadata: { plan_name: t.plan_name, ends_on: t.ends_on },
    });
    created += r.length;
  }

  // 2. memberships that expired TODAY (ACTIVE→EXPIRED already flipped lazily)
  const { rows: expired } = await query(
    `SELECT t.id, t.plan_name, t.ends_on, gm.first_name, gm.last_name, gm.id AS member_id
     FROM member_memberships t JOIN gym_members gm ON gm.id = t.member_id
     WHERE gm.gym_id = $1 AND t.status = 'EXPIRED' AND t.ends_on = $2::date`,
    [gymId, todayIso]
  );
  for (const t of expired) {
    const name = [t.first_name, t.last_name].filter(Boolean).join(' ');
    const r = await insertForEvent(null, {
      gymId, type: 'MEMBERSHIP_EXPIRED',
      title: 'Membership expired',
      message: `${name}'s ${t.plan_name} membership expired today.`,
      entityType: 'MEMBERSHIP', entityId: t.id, memberId: t.member_id,
      dedupeKey: `membership_expired:${t.id}:${t.ends_on}`,
      metadata: { plan_name: t.plan_name, ends_on: t.ends_on },
    });
    created += r.length;
  }

  // 3. overdue charges (unpaid past due_on — the ledger's DUE status is
  //    derived; OVERDUE = due_on < today with outstanding balance)
  const { rows: overdue } = await query(
    `SELECT c.id, c.description, c.amount_cents, c.currency, c.due_on,
            gm.first_name, gm.last_name, gm.id AS member_id
     FROM membership_charges c JOIN gym_members gm ON gm.id = c.member_id
     WHERE c.gym_id = $1 AND c.due_on < $2::date
       AND c.amount_cents > COALESCE((
         SELECT SUM(p.amount_cents) FROM membership_payments p
         WHERE p.charge_id = c.id), 0)
       AND NOT EXISTS (
         SELECT 1 FROM payment_refunds f JOIN membership_payments pay ON pay.id = f.payment_id
         WHERE pay.charge_id = c.id)
     LIMIT 100`,
    [gymId, todayIso]
  );
  for (const c of overdue) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const r = await insertForEvent(null, {
      gymId, type: 'PAYMENT_OVERDUE',
      title: 'Payment overdue',
      message: `${name} has ${(c.amount_cents / 100).toFixed(2)} ${c.currency} overdue since ${c.due_on} (${c.description}).`,
      entityType: 'CHARGE', entityId: c.id, memberId: c.member_id,
      dedupeKey: `payment_overdue:${c.id}:${todayIso}`,
      metadata: { amount_cents: c.amount_cents, currency: c.currency, due_on: c.due_on },
    });
    created += r.length;
  }

  // 4. inactive members: ACTIVE membership but no visit for N days
  const { rows: inactive } = await query(
    `SELECT gm.id AS member_id, gm.first_name, gm.last_name,
            MAX(a.check_in_at)::date::text AS last_visit
     FROM gym_members gm
     JOIN member_memberships t ON t.member_id = gm.id AND t.status = 'ACTIVE'
     LEFT JOIN gym_attendance a ON a.member_id = gm.id
     WHERE gm.gym_id = $1 AND gm.status = 'ACTIVE'
     GROUP BY gm.id, gm.first_name, gm.last_name
     HAVING COALESCE(MAX(a.check_in_at), 'epoch') < (now() - ($2 || ' days')::interval)
     LIMIT 100`,
    [gymId, inactiveDays]
  );
  for (const m of inactive) {
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ');
    const days = m.last_visit
      ? Math.round((Date.now() - new Date(m.last_visit)) / 86400000)
      : inactiveDays;
    const r = await insertForEvent(null, {
      gymId, type: 'MEMBER_INACTIVE',
      title: 'Attendance alert',
      message: m.last_visit
        ? `${name} has not visited the gym for ${days} days (last visit ${m.last_visit}).`
        : `${name} has an active membership but no recorded visits.`,
      entityType: 'MEMBER', entityId: m.member_id, memberId: m.member_id,
      dedupeKey: `member_inactive:${m.member_id}:${todayIso}`,
      metadata: { last_visit: m.last_visit, days },
    });
    created += r.length;
  }

  return { created };
}

module.exports = {
  TYPES, CATEGORIES, SEVERITIES,
  notifyStaff, listForUser, unreadCount, getForUser, markRead, markAllRead,
  runStaffNotificationScan,
};
