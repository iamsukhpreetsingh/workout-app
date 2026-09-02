// gyms.js — data access for the Gym Management System foundation:
// gyms, staff (gym-scoped roles), members (no app account required),
// app-account linking, and the audit log.
//
// RULES (GYM_MANAGEMENT_DESIGN.md):
//  - users is the global identity; User.gymId is forbidden. Relationships
//    live in gym_staff / gym_members.
//  - A gym member does NOT need an app account (app_user_id NULL).
//  - Linking is by exact verified email and never duplicates a member row
//    or a user account.
//  - Every mutation writes an audit_logs row in the same transaction.
//  - The last ACTIVE OWNER of a gym can never be demoted/removed.
const { pool, query, transaction } = require('../db/pool');
const { hasPermission } = require('./gymPermissions');
const crypto = require('crypto');

// an accepted invitation never outlives this window
const INVITE_TTL_DAYS = 7;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'gym';

const GYM_ROLES = ['OWNER', 'ADMIN', 'TRAINER', 'FRONT_DESK', 'MEMBER'];
const STAFF_STATUSES = ['ACTIVE', 'INACTIVE', 'REMOVED'];
const MEMBER_STATUSES = ['ACTIVE', 'PENDING', 'FROZEN', 'EXPIRED', 'CANCELLED'];

// ── onboarding profile validation (backend is the authority; the wizard
//    adds AntD client-side rules but these run on EVERY create/update) ────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\-.\s0-9]{6,20}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function assertTimezone(tz) {
  if (typeof tz !== 'string' || !tz) throw new HttpError(400, 'timezone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new HttpError(400, `invalid timezone: ${tz}`);
  }
}

function assertContact({ phone, email, website }) {
  if (email != null && email !== '' && !EMAIL_RE.test(String(email))) {
    throw new HttpError(400, 'invalid email address');
  }
  if (phone != null && phone !== '' && !PHONE_RE.test(String(phone))) {
    throw new HttpError(400, 'invalid phone number (digits, spaces and +()-. only)');
  }
  if (website != null && website !== '') {
    let parsed = null;
    try { parsed = new URL(String(website)); } catch { /* not a URL */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new HttpError(400, 'website must be a valid http(s) URL');
    }
  }
}

// Normalize to all 7 days. Omitted/blank days read as CLOSED (explicit user
// intent, not missing data). Times are 24h HH:MM; open must precede close —
// compared as zero-padded strings, which is order-correct.
function normalizeOperatingHours(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'operating_hours must be an object keyed by day (mon..sun)');
  }
  const out = {};
  for (const day of WEEK_DAYS) {
    const d = input[day];
    if (!d || d.closed) { out[day] = { closed: true }; continue; }
    const open = String(d.open ?? '').trim();
    const close = String(d.close ?? '').trim();
    if (!HHMM_RE.test(open) || !HHMM_RE.test(close)) {
      throw new HttpError(400, `operating_hours.${day}: open/close must be 24h HH:MM times`);
    }
    if (open >= close) {
      throw new HttpError(400, `operating_hours.${day}: closing time must be after opening time`);
    }
    out[day] = { open, close };
  }
  return out;
}

function normalizeBranding(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'branding must be an object');
  }
  const out = {};
  for (const key of ['primary_color', 'secondary_color']) {
    const v = input[key];
    if (v != null && v !== '') {
      if (!HEX_COLOR_RE.test(String(v))) {
        throw new HttpError(400, `branding.${key} must be a hex color (e.g. #E8481F)`);
      }
      out[key] = String(v);
    }
  }
  return out;
}

// The onboarding checklist the dashboard renders. Missing items drive the
// portal's empty states — the backend owns the definition of "complete".
function gymProfileCompletion(gym) {
  const checks = [
    ['name', !!gym.name],
    ['logo', !!gym.logo_key],
    ['address', !!(gym.address_line1 && gym.city)],
    ['phone', !!gym.phone],
    ['email', !!gym.email],
    ['website', !!gym.website],
    ['operating_hours', !!gym.operating_hours],
    ['branding', !!(gym.branding && gym.branding.primary_color)],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    missing: checks.filter(([, ok]) => !ok).map(([key]) => key),
  };
}

// ── audit ────────────────────────────────────────────────────────────────
async function gymAudit(client, { gymId, actorUserId, actorLabel, action, entity, entityId, before, after, ip }) {
  await client.query(
    `INSERT INTO audit_logs (gym_id, actor_user_id, actor_label, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [gymId ?? null, actorUserId ?? null, actorLabel ?? null, action, entity,
     entityId != null ? String(entityId) : null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
     ip ?? null]
  );
}

// ── gyms ─────────────────────────────────────────────────────────────────

// Create a gym: caller becomes its OWNER. If the caller is a plain app user,
// users.role upgrades to 'gym_staff' so login routes them to the portal.
// A trainer keeps role 'trainer' (global role untouched — the gym role is
// decided by gym_staff alone).
//
// Personal fitness data is NEVER touched: only users.role changes (and only
// 'user' → 'gym_staff'). Workouts, diet, progress and trainer relationships
// are untouched rows in other tables.
//
// Duplicate gym names are allowed (two "Gold's Gym" owners) — uniqueness is
// the machine-generated slug. Runs in ONE transaction so a failure halfway
// through leaves no partial gym/staff rows.
async function createGym(userId, ip, payload = {}) {
  const {
    name, timezone, currency, website, operating_hours, branding,
    address_line1, address_line2, city, state, postal_code, phone, email,
  } = payload;
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 120) throw new HttpError(400, 'name is required (max 120 characters)');
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter code');
  if (timezone) assertTimezone(timezone);
  assertContact({ phone, email, website });
  const hours = normalizeOperatingHours(operating_hours);
  const colors = normalizeBranding(branding);
  return transaction(async (client) => {
    const slug = `${slugify(trimmed)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { rows: gymRows } = await client.query(
      `INSERT INTO gyms (name, slug, timezone, currency, website, operating_hours, branding,
                         address_line1, address_line2, city, state, postal_code, phone, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [trimmed, slug, timezone || 'UTC', currency || 'INR', website || null,
       hours ? JSON.stringify(hours) : null, colors ? JSON.stringify(colors) : null,
       address_line1 ?? null, address_line2 ?? null, city ?? null, state ?? null,
       postal_code ?? null, phone ?? null, email ?? null]
    );
    const gym = gymRows[0];
    await client.query(
      `INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1,$2,'OWNER')`,
      [gym.id, userId]
    );
    const { rows: userRows } = await client.query(
      `UPDATE users SET role = 'gym_staff', updated_at = now()
       WHERE id = $1 AND role = 'user' RETURNING id, role`,
      [userId]
    );
    await gymAudit(client, {
      gymId: gym.id, actorUserId: userId, ip,
      action: 'gym.created', entity: 'gym', entityId: gym.id, after: { name: gym.name },
    });
    return { gym, membershipRole: userRows[0]?.role || null, profile_completion: gymProfileCompletion(gym) };
  });
}

async function listGymsForStaff(userId) {
  // Includes owner-deactivated (INACTIVE) gyms so the portal can show them
  // and offer reactivation; SUSPENDED gyms are hidden (platform decision).
  const { rows } = await query(
    `SELECT g.id, g.name, g.slug, g.status AS gym_status, g.logo_key,
            s.gym_role, s.status AS staff_status, s.created_at AS staff_since
     FROM gym_staff s JOIN gyms g ON g.id = s.gym_id
     WHERE s.user_id = $1 AND s.status = 'ACTIVE' AND g.status != 'SUSPENDED'
     ORDER BY g.name`,
    [userId]
  );
  return rows;
}

async function getGymById(gymId) {
  const { rows } = await query('SELECT * FROM gyms WHERE id = $1', [gymId]);
  return rows[0] || null;
}

async function updateGym(gymId, actor, patch, ip) {
  const allowed = ['name', 'timezone', 'currency', 'website', 'operating_hours', 'branding',
    'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'phone', 'email', 'settings'];
  const sets = [];
  const vals = [gymId];
  const before = await getGymById(gymId);
  if (!before) throw new HttpError(404, 'Gym not found');
  const patchNorm = { ...patch };
  if (patchNorm.timezone !== undefined) assertTimezone(patchNorm.timezone || null);
  assertContact({
    phone: patchNorm.phone !== undefined ? patchNorm.phone : undefined,
    email: patchNorm.email !== undefined ? patchNorm.email : undefined,
    website: patchNorm.website !== undefined ? patchNorm.website : undefined,
  });
  if (patchNorm.operating_hours !== undefined) {
    patchNorm.operating_hours = normalizeOperatingHours(patchNorm.operating_hours);
    if (patchNorm.operating_hours === null) delete patchNorm.operating_hours;
  }
  if (patchNorm.branding !== undefined) {
    patchNorm.branding = normalizeBranding(patchNorm.branding);
    if (patchNorm.branding === null) delete patchNorm.branding;
  }
  for (const [k, v] of Object.entries(patchNorm)) {
    if (!allowed.includes(k) || v === undefined) continue;
    if (k === 'name' && (!String(v).trim() || String(v).length > 120)) {
      throw new HttpError(400, 'name is required (max 120 characters)');
    }
    if (k === 'email' && v !== null && v !== '' && !EMAIL_RE.test(String(v))) {
      throw new HttpError(400, 'invalid email address');
    }
    if (k === 'timezone' && !v) {
      throw new HttpError(400, 'timezone cannot be empty');
    }
    vals.push(v instanceof Object && !(v instanceof Date) ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No valid fields to update');
  const { rows } = await query(
    `UPDATE gyms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals
  );
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: 'gym.updated', entity: 'gym', entityId: gymId, before, after: rows[0],
  });
  return rows[0];
}

// ── gym lifecycle: leave / deactivate / reactivate ───────────────────────

// Logo storage keys are NEVER accepted through the generic PATCH — a client
// could otherwise point the gym at arbitrary stored files. Only this
// function (called by the authorized logo routes) writes logo columns.
async function setGymLogo(gymId, actor, ip, { logo_key, logo_provider }) {
  const { rows } = await query(
    `UPDATE gyms SET logo_key = $2, logo_provider = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [gymId, logo_key ?? null, logo_key ? (logo_provider || 'local') : null]
  );
  if (!rows.length) throw new HttpError(404, 'Gym not found');
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: logo_key ? 'gym.logo_updated' : 'gym.logo_removed',
    entity: 'gym', entityId: gymId, after: { logo_key: rows[0].logo_key },
  });
  return rows[0];
}

// A staff member leaves the gym voluntarily. The LAST ACTIVE OWNER cannot —
// a gym must always keep exactly-at-least-one reachable owner. An owner who
// wants out transfers ownership first (staff.manage) or deactivates the gym.
async function leaveGym(gymId, userId, ip) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_staff WHERE gym_id = $1 AND user_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [gymId, userId]
    );
    if (!rows.length) throw new HttpError(404, 'You are not active staff at this gym');
    const staff = rows[0];
    if (staff.gym_role === 'OWNER' && (await countActiveOwners(client, gymId, staff.id)) === 0) {
      throw new HttpError(400,
        'You are the only active owner. Transfer ownership to another staff member (or deactivate the gym) before leaving.');
    }
    await client.query(
      `UPDATE gym_staff SET status = 'REMOVED', updated_at = now() WHERE id = $1`,
      [staff.id]
    );
    await gymAudit(client, {
      gymId, actorUserId: userId, ip, action: 'staff.left',
      entity: 'gym_staff', entityId: staff.id, before: { gym_role: staff.gym_role },
      after: { status: 'REMOVED' },
    });
    return { ok: true };
  });
}

// Owner-controlled deactivation (self-service). SUSPENDED is the platform's
// state and is never set or cleared here.
async function deactivateGym(gymId, actor, ip) {
  return transaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM gyms WHERE id = $1 FOR UPDATE`, [gymId]);
    if (!rows.length) throw new HttpError(404, 'Gym not found');
    if (rows[0].status === 'SUSPENDED') {
      throw new HttpError(400, 'This gym is suspended by the platform — contact support');
    }
    if (rows[0].status === 'INACTIVE') return rows[0]; // idempotent
    const { rows: updated } = await client.query(
      `UPDATE gyms SET status = 'INACTIVE', updated_at = now() WHERE id = $1 RETURNING *`,
      [gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'gym.deactivated', entity: 'gym', entityId: gymId,
      before: { status: rows[0].status }, after: { status: 'INACTIVE' },
    });
    return updated[0];
  });
}

// Reactivation resolves the caller's staff row DIRECTLY (bypassing
// requireGymContext, which correctly rejects non-ACTIVE gyms). Only an
// ACTIVE OWNER of the gym may reactivate; a platform-suspended gym never is.
async function reactivateGym(gymId, userId, ip) {
  return transaction(async (client) => {
    const { rows: staff } = await client.query(
      `SELECT s.*, g.status AS gym_status
       FROM gym_staff s JOIN gyms g ON g.id = s.gym_id
       WHERE s.gym_id = $1 AND s.user_id = $2 AND s.status = 'ACTIVE' FOR UPDATE OF s`,
      [gymId, userId]
    );
    if (!staff.length) throw new HttpError(403, 'You do not have access to this gym');
    if (staff[0].gym_role !== 'OWNER') {
      throw new HttpError(403, 'Only the gym owner can reactivate the gym');
    }
    if (staff[0].gym_status === 'SUSPENDED') {
      throw new HttpError(403, 'This gym is suspended by the platform — contact support');
    }
    if (staff[0].gym_status === 'ACTIVE') return { ok: true, alreadyActive: true };
    await client.query(
      `UPDATE gyms SET status = 'ACTIVE', updated_at = now() WHERE id = $1`, [gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: userId, ip, action: 'gym.reactivated',
      entity: 'gym', entityId: gymId,
      before: { status: staff[0].gym_status }, after: { status: 'ACTIVE' },
    });
    return { ok: true };
  });
}

// ── staff ────────────────────────────────────────────────────────────────

async function listGymStaff(gymId) {
  const { rows } = await query(
    `SELECT s.id, s.gym_role, s.status, s.created_at, u.name, u.email
     FROM gym_staff s JOIN users u ON u.id = s.user_id
     WHERE s.gym_id = $1 AND s.status != 'REMOVED'
     ORDER BY s.created_at`,
    [gymId]
  );
  return rows;
}

async function countActiveOwners(client, gymId, excludeStaffId = null) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM gym_staff
     WHERE gym_id = $1 AND gym_role = 'OWNER' AND status = 'ACTIVE' AND id != $2`,
    [gymId, excludeStaffId ?? null]
  );
  return rows[0].c;
}

// Add staff by EMAIL — the person must already have an app account (staff
// authenticate through `users`). No user row is created here.
async function addGymStaff(gymId, actor, ip, { email, gym_role }) {
  if (!GYM_ROLES.includes(gym_role) || gym_role === 'MEMBER') {
    throw new HttpError(400, 'gym_role must be one of OWNER, ADMIN, TRAINER, FRONT_DESK');
  }
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) throw new HttpError(400, 'email is required');
  const { rows: users } = await query(
    'SELECT id, name, email, role FROM users WHERE lower(email) = $1',
    [emailNorm]
  );
  if (!users.length) throw new HttpError(404, 'No app account with that email. The person must sign up first.');
  const user = users[0];
  return transaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id, status FROM gym_staff WHERE gym_id = $1 AND user_id = $2`,
      [gymId, user.id]
    );
    if (existing.length) {
      if (existing[0].status === 'ACTIVE') throw new HttpError(409, 'This user is already staff at this gym');
      // re-hire a previously removed/inactive staff member
      const { rows: rehired } = await client.query(
        `UPDATE gym_staff SET gym_role = $3, status = 'ACTIVE', updated_at = now()
         WHERE id = $1 AND gym_id = $2 RETURNING *`,
        [existing[0].id, gymId, gym_role]
      );
      await gymAudit(client, {
        gymId, actorUserId: actor, ip, action: 'staff.rehired',
        entity: 'gym_staff', entityId: existing[0].id, after: { gym_role, user: user.email },
      });
      return rehired[0];
    }
    const { rows: inserted } = await client.query(
      `INSERT INTO gym_staff (gym_id, user_id, gym_role) VALUES ($1,$2,$3) RETURNING *`,
      [gymId, user.id, gym_role]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor, ip, action: 'staff.added',
      entity: 'gym_staff', entityId: inserted[0].id, after: { gym_role, user: user.email },
    });
    return inserted[0];
  });
}

// Change a staff member's role or status. The last ACTIVE OWNER can never be
// demoted/removed — ownership transfer must happen first.
async function updateGymStaff(gymId, staffId, actor, ip, { gym_role, status }) {
  if (gym_role !== undefined && !GYM_ROLES.includes(gym_role)) {
    throw new HttpError(400, 'invalid gym_role');
  }
  if (status !== undefined && !STAFF_STATUSES.includes(status)) {
    throw new HttpError(400, 'invalid status');
  }
  return transaction(async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM gym_staff WHERE id = $1 AND gym_id = $2`,
      [staffId, gymId]
    );
    if (!currentRows.length) throw new HttpError(404, 'Staff not found');
    const current = currentRows[0];
    const willLoseOwner =
      current.gym_role === 'OWNER' &&
      ((gym_role !== undefined && gym_role !== 'OWNER') ||
       (status !== undefined && status !== 'ACTIVE'));
    if (willLoseOwner && (await countActiveOwners(client, gymId, staffId)) === 0) {
      throw new HttpError(400, 'Cannot demote or remove the last active owner. Transfer ownership first.');
    }
    const { rows } = await client.query(
      `UPDATE gym_staff SET
         gym_role = COALESCE($3, gym_role),
         status = COALESCE($4, status),
         updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [staffId, gymId, gym_role ?? null, status ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor, ip, action: 'staff.updated',
      entity: 'gym_staff', entityId: staffId,
      before: { gym_role: current.gym_role, status: current.status },
      after: { gym_role: rows[0].gym_role, status: rows[0].status },
    });
    return rows[0];
  });
}

// ── members ──────────────────────────────────────────────────────────────

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function memberCreateValidation(data) {
  const first = String(data.first_name || '').trim();
  if (!first || first.length > 80) throw new HttpError(400, 'first_name is required (max 80 characters)');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new HttpError(400, 'invalid email');
  }
  if (data.phone && !PHONE_RE.test(String(data.phone))) {
    throw new HttpError(400, 'invalid phone number (digits, spaces and +()-. only)');
  }
  if (data.status && !MEMBER_STATUSES.includes(data.status)) throw new HttpError(400, 'invalid status');
  if (data.gender && !GENDERS.includes(data.gender)) throw new HttpError(400, 'invalid gender');
  if (data.date_of_birth) {
    // pg returns DATE columns as Date objects on read; normalize before
    // validating so an unchanged dob in an update doesn't false-fail
    const dobStr = data.date_of_birth instanceof Date
      ? data.date_of_birth.toISOString().slice(0, 10)
      : String(data.date_of_birth).slice(0, 10);
    if (!ISO_DATE_RE.test(dobStr)) {
      throw new HttpError(400, 'date_of_birth must be a YYYY-MM-DD date');
    }
    const dob = new Date(`${dobStr}T00:00:00Z`);
    if (Number.isNaN(dob.getTime()) || dob > new Date()) {
      throw new HttpError(400, 'date_of_birth must be a real date in the past');
    }
  }
  if (data.emergency_contact_phone && !PHONE_RE.test(String(data.emergency_contact_phone))) {
    throw new HttpError(400, 'invalid emergency contact phone');
  }
  if (data.profile !== undefined && data.profile != null &&
      (typeof data.profile !== 'object' || Array.isArray(data.profile))) {
    throw new HttpError(400, 'profile must be an object');
  }
}

// Members carry TWO independent state axes (spec: never combine):
//   membership     = status column
//   app connection = derived from app_user_id + app_invite_status
function memberToClient(row) {
  if (!row) return row;
  const app_connection = row.app_user_id
    ? 'CONNECTED'
    : row.app_invite_status === 'pending' ? 'INVITATION_PENDING' : 'NOT_CONNECTED';
  return { ...row, app_connection };
}

async function createGymMember(gymId, actor, ip, data) {
  memberCreateValidation(data);
  return transaction(async (client) => {
    // duplicate guard: one member row per email per gym (other gyms are
    // unaffected — the same person can be a member of many gyms). Members
    // without an email are always allowed (email is optional).
    if (data.email) {
      const emailNorm = String(data.email).trim().toLowerCase();
      const { rows: dupes } = await client.query(
        `SELECT id, member_code, status FROM gym_members
         WHERE gym_id = $1 AND lower(email) = $2 AND status != 'CANCELLED'`,
        [gymId, emailNorm]
      );
      if (dupes.length) {
        throw new HttpError(409,
          `A member with this email already exists at this gym (${dupes[0].member_code})`);
      }
    }
    const { rows } = await client.query(
      `INSERT INTO gym_members
         (gym_id, first_name, last_name, email, phone, status, notes, joined_at,
          date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,$10,$11,$12,$13)
       RETURNING *`,
      [gymId, String(data.first_name).trim(), data.last_name ?? null,
       data.email ?? null, data.phone ?? null,
       data.status || 'ACTIVE', data.notes ?? null, data.joined_at ?? null,
       data.date_of_birth ?? null, data.gender ?? null,
       data.emergency_contact_name ?? null, data.emergency_contact_phone ?? null,
       data.profile ? JSON.stringify(data.profile) : '{}']
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.created', entity: 'gym_member', entityId: rows[0].id,
      after: { name: rows[0].first_name, email: rows[0].email, status: rows[0].status },
    });
    return memberToClient(rows[0]);
  });
}

async function listGymMembers(gymId, { status, connection, q, limit = 50, offset = 0 }) {
  const vals = [gymId];
  const where = ['gym_id = $1'];
  if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
  // APP CONNECTION is a separate axis from membership status
  if (connection === 'CONNECTED') where.push('app_user_id IS NOT NULL');
  else if (connection === 'NOT_CONNECTED') where.push(`app_user_id IS NULL AND app_invite_status = 'none'`);
  else if (connection === 'INVITATION_PENDING') where.push(`app_user_id IS NULL AND app_invite_status = 'pending'`);
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(first_name ILIKE $${vals.length} OR last_name ILIKE $${vals.length}
                 OR email ILIKE $${vals.length} OR member_code ILIKE $${vals.length}
                 OR phone ILIKE $${vals.length})`);
  }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 50, 200)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT * FROM gym_members WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows.map(memberToClient);
}

async function getGymMember(gymId, memberId) {
  const { rows } = await query(
    'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  return memberToClient(rows[0] || null);
}

async function updateGymMember(gymId, memberId, actor, ip, patch) {
  const allowed = ['first_name', 'last_name', 'email', 'phone', 'status', 'notes', 'joined_at',
    'date_of_birth', 'gender', 'emergency_contact_name', 'emergency_contact_phone', 'profile'];
  const sets = [];
  const vals = [memberId, gymId];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k) || v === undefined) continue;
    vals.push(v instanceof Object && !(v instanceof Date) ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'No valid fields to update');
  return transaction(async (client) => {
    const { rows: beforeRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2', [memberId, gymId]
    );
    if (!beforeRows.length) throw new HttpError(404, 'Member not found');
    memberCreateValidation({ ...beforeRows[0], ...patch });
    // duplicate-email guard on contact-detail changes (see createGymMember)
    const emailChanged = patch.email !== undefined &&
      String(patch.email || '').trim().toLowerCase() !== String(beforeRows[0].email || '').toLowerCase();
    if (emailChanged && patch.email) {
      const { rows: dupes } = await client.query(
        `SELECT id, member_code FROM gym_members
         WHERE gym_id = $1 AND lower(email) = $2 AND id != $3 AND status != 'CANCELLED'`,
        [gymId, String(patch.email).trim().toLowerCase(), memberId]
      );
      if (dupes.length) {
        throw new HttpError(409,
          `Another member of this gym already uses this email (${dupes[0].member_code})`);
      }
    }
    const { rows } = await client.query(
      `UPDATE gym_members SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      vals
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.updated', entity: 'gym_member', entityId: memberId,
      before: { status: beforeRows[0].status, email: beforeRows[0].email },
      after: { status: rows[0].status, email: rows[0].email },
    });
    return memberToClient(rows[0]);
  });
}

// ── member lifecycle: leave (cancel) / reactivate ────────────────────────

// "Member leaves": membership → CANCELLED. The row (and all of the
// member's history) is kept, and any linked app User account is NEVER
// touched — the link survives a reactivation.
async function cancelGymMember(gymId, memberId, actor, ip, { reason } = {}) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Member not found');
    if (rows[0].status === 'CANCELLED') return memberToClient(rows[0]); // idempotent
    const { rows: updated } = await client.query(
      `UPDATE gym_members SET status = 'CANCELLED', updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [memberId, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.cancelled', entity: 'gym_member', entityId: memberId,
      before: { status: rows[0].status },
      after: { status: 'CANCELLED', reason: reason ?? null },
    });
    return memberToClient(updated[0]);
  });
}

// "Member reactivates": back to ACTIVE. Only a non-ACTIVE member can be
// reactivated; the app link (if any) is untouched.
async function reactivateGymMember(gymId, memberId, actor, ip) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Member not found');
    if (rows[0].status === 'ACTIVE') return memberToClient(rows[0]); // idempotent
    const { rows: updated } = await client.query(
      `UPDATE gym_members SET status = 'ACTIVE', updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [memberId, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.reactivated', entity: 'gym_member', entityId: memberId,
      before: { status: rows[0].status }, after: { status: 'ACTIVE' },
    });
    return memberToClient(updated[0]);
  });
}

// ── app invitations (NOT_CONNECTED → INVITATION_PENDING → CONNECTED) ─────

// Invite (or re-invite) a member to connect an app account. Requires the
// member to have an email. The invite code is returned ONCE (for the
// portal to show/copy) and only its SHA-256 hash is stored.
async function inviteMemberApp(gymId, memberId, actor, ip, { email } = {}) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const member = memberRows[0];
    if (member.app_user_id) {
      throw new HttpError(400, 'This member is already connected to an app account');
    }
    const inviteEmail = String(email || member.email || '').trim().toLowerCase();
    if (!inviteEmail) {
      throw new HttpError(400, 'The member needs an email address to receive an invitation');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
      throw new HttpError(400, 'invalid email');
    }
    const code = crypto.randomBytes(16).toString('hex'); // shown once, stored hashed
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);

    // expire any previous pending invite (partial unique: one PENDING/member)
    await client.query(
      `UPDATE gym_member_invites SET status = 'EXPIRED', updated_at = now()
       WHERE member_id = $1 AND status = 'PENDING'`,
      [memberId]
    );
    await client.query(
      `INSERT INTO gym_member_invites (gym_id, member_id, email, code_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [gymId, memberId, inviteEmail, codeHash, actor?.userId ?? actor ?? null, expiresAt]
    );
    await client.query(
      `UPDATE gym_members SET app_invite_status = 'pending', app_invite_sent_at = now(),
       email = COALESCE(email, $3), updated_at = now() WHERE id = $1 AND gym_id = $2`,
      [memberId, gymId, inviteEmail]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.invited', entity: 'gym_member', entityId: memberId,
      after: { email: inviteEmail },
    });
    return { invite_code: code, email: inviteEmail };
  });
}

// Withdraw a pending invitation — the member returns to NOT_CONNECTED.
async function cancelMemberInvite(gymId, memberId, actor, ip) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    await client.query(
      `UPDATE gym_member_invites SET status = 'CANCELLED', updated_at = now()
       WHERE member_id = $1 AND status = 'PENDING'`,
      [memberId]
    );
    await client.query(
      `UPDATE gym_members SET app_invite_status = 'none', updated_at = now()
       WHERE id = $1 AND gym_id = $2`,
      [memberId, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.invite_cancelled', entity: 'gym_member', entityId: memberId,
    });
    return { ok: true };
  });
}

// ── app-account linking ──────────────────────────────────────────────────

// Link an existing GymMember to an app account by EXACT email match. The
// member row is UPDATED (never duplicated) and the user account is never
// created or modified here. Guarded by the partial-unique index so two
// ACTIVE members in the same gym can never share one app account.
async function linkMemberToApp(gymId, memberId, actor, ip, { email }) {
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) throw new HttpError(400, 'email is required');
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const member = memberRows[0];
    const { rows: users } = await client.query(
      'SELECT id, name, email FROM users WHERE lower(email) = $1',
      [emailNorm]
    );
    if (!users.length) throw new HttpError(404, 'No app account with that email');
    const user = users[0];
    const { rows: clash } = await client.query(
      `SELECT id FROM gym_members
       WHERE gym_id = $1 AND app_user_id = $2 AND id != $3
         AND status IN ('ACTIVE','PENDING','FROZEN')`,
      [gymId, user.id, member.id]
    );
    if (clash.length) {
      throw new HttpError(409, 'That app account is already linked to another member of this gym');
    }
    const { rows } = await client.query(
      `UPDATE gym_members SET app_user_id = $3, app_invite_status = 'none', updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [member.id, gymId, user.id]
    );
    // consume any pending invitation — the app account IS the connection
    await client.query(
      `UPDATE gym_member_invites SET status = 'ACCEPTED', accepted_at = now(), updated_at = now()
       WHERE member_id = $1 AND status = 'PENDING'`,
      [member.id]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.linked_app', entity: 'gym_member', entityId: member.id,
      before: { app_user_id: member.app_user_id },
      after: { app_user_id: user.id, user_email: user.email },
    });
    return memberToClient(rows[0]);
  });
}

async function unlinkMemberFromApp(gymId, memberId, actor, ip) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].app_user_id == null) return memberRows[0];
    const before = { app_user_id: memberRows[0].app_user_id };
    const { rows } = await client.query(
      `UPDATE gym_members SET app_user_id = NULL, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [memberId, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'member.unlinked_app', entity: 'gym_member', entityId: memberId,
      before, after: { app_user_id: null },
    });
    return memberToClient(rows[0]);
  });
}

// Gym-member view (app-linked): the gyms/memberships this user belongs to.
async function listGymMembershipsForUser(userId) {
  const { rows } = await query(
    `SELECT m.id, m.member_code, m.status, m.joined_at,
            g.id AS gym_id, g.name AS gym_name, g.slug AS gym_slug
     FROM gym_members m JOIN gyms g ON g.id = m.gym_id
     WHERE m.app_user_id = $1 AND m.status IN ('ACTIVE','PENDING','FROZEN')
     ORDER BY g.name`,
    [userId]
  );
  return rows;
}

// ── invitation acceptance bridge (Gym ⇄ fitness app) ─────────────────────
//
// The plaintext code is a bearer token (128-bit random, shown once, stored
// hashed). Acceptance is identity-verified: the accepting account's email
// must match the invited email EXACTLY. Arbitrary linking ("put user X into
// gymMember GM100") is impossible — there is no such route; staff linking
// requires members.manage, personal linking requires the invitation token.

function hashInviteCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

async function findInvitationForAccept(client, code) {
  const { rows } = await client.query(
    `SELECT i.*, g.name AS gym_name, g.status AS gym_status,
            m.first_name, m.last_name, m.status AS member_status, m.id AS member_id
     FROM gym_member_invites i
     JOIN gyms g ON g.id = i.gym_id
     JOIN gym_members m ON m.id = i.member_id
     WHERE i.code_hash = $1
     ORDER BY i.created_at DESC LIMIT 1`,
    [hashInviteCode(code)]
  );
  return rows[0] || null;
}

// public, token-keyed view of an invitation (portal landing page data)
async function getInvitationByToken(code) {
  const invite = await query(
    `SELECT i.id, i.email, i.status, i.expires_at, i.created_at, i.accepted_at,
            g.name AS gym_name, g.status AS gym_status,
            m.first_name, m.last_name, m.status AS member_status
     FROM gym_member_invites i
     JOIN gyms g ON g.id = i.gym_id
     JOIN gym_members m ON m.id = i.member_id
     WHERE i.code_hash = $1
     ORDER BY i.created_at DESC LIMIT 1`,
    [hashInviteCode(code)]
  );
  if (!invite.rows.length) return null;
  const row = invite.rows[0];
  let status = row.status;
  if (status === 'PENDING' && new Date(row.expires_at) < new Date()) status = 'EXPIRED';
  return {
    gymName: row.gym_name,
    gymStatus: row.gym_status,
    memberName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    memberStatus: row.member_status,
    email: row.email,
    status,
    invitedAt: row.created_at,
    acceptedAt: row.accepted_at,
  };
}

// all shared validations for accept/register; returns the locked invite row
async function lockAcceptableInvitation(client, code) {
  const invite = await findInvitationForAccept(client, code);
  if (!invite) throw new HttpError(404, 'Invitation not found');
  if (invite.status === 'PENDING' && new Date(invite.expires_at) < new Date()) {
    await client.query(
      `UPDATE gym_member_invites SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
      [invite.id]
    );
    throw new HttpError(410, 'This invitation has expired. Ask your gym to send a new one.');
  }
  if (invite.status === 'ACCEPTED') throw new HttpError(409, 'This invitation was already accepted');
  if (invite.status === 'DECLINED') throw new HttpError(410, 'This invitation was declined');
  if (invite.status === 'CANCELLED') throw new HttpError(410, 'This invitation was cancelled by the gym');
  if (invite.status === 'EXPIRED') throw new HttpError(410, 'This invitation has expired. Ask your gym to send a new one.');
  if (invite.gym_status === 'SUSPENDED') throw new HttpError(403, 'This gym is currently unavailable');
  if (invite.gym_status === 'INACTIVE') throw new HttpError(403, 'This gym is deactivated — ask your gym to reactivate it first');
  if (invite.member_status === 'CANCELLED') {
    throw new HttpError(410, 'This membership is no longer active — the invitation cannot be used');
  }
  return invite;
}

// Scenario 1: the person ALREADY has an app account. They log in and open
// the invitation; the account's email must match the invited email.
async function acceptInvitation(code, userId, ip) {
  return transaction(async (client) => {
    const invite = await lockAcceptableInvitation(client, code);
    const { rows: userRows } = await client.query(
      'SELECT id, email FROM users WHERE id = $1', [userId]
    );
    if (!userRows.length) throw new HttpError(401, 'Account not found');
    const user = userRows[0];
    if (String(user.email).toLowerCase() !== String(invite.email).toLowerCase()) {
      // identity verification: the invitation belongs to a specific email
      throw new HttpError(403,
        `This invitation was sent to ${invite.email}. Sign in with that account to accept it.`);
    }
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [invite.member_id, invite.gym_id]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].app_user_id) {
      throw new HttpError(409, 'This member is already connected to an app account');
    }
    const { rows: clash } = await client.query(
      `SELECT id FROM gym_members
       WHERE gym_id = $1 AND app_user_id = $2 AND id != $3
         AND status IN ('ACTIVE','PENDING','FROZEN')`,
      [invite.gym_id, user.id, memberRows[0].id]
    );
    if (clash.length) {
      throw new HttpError(409, 'That app account is already linked to another member of this gym');
    }
    await client.query(
      `UPDATE gym_members SET app_user_id = $2, app_invite_status = 'none', updated_at = now()
       WHERE id = $1`,
      [memberRows[0].id, user.id]
    );
    await client.query(
      `UPDATE gym_member_invites SET status = 'ACCEPTED', accepted_at = now(),
         accepted_user_id = $2, updated_at = now() WHERE id = $1`,
      [invite.id, user.id]
    );
    await gymAudit(client, {
      gymId: invite.gym_id, actorUserId: user.id, ip,
      action: 'member.invite_accepted', entity: 'gym_member', entityId: memberRows[0].id,
      after: { app_user_id: user.id, email: user.email },
    });
    return {
      ok: true,
      gymName: invite.gym_name,
      member: memberToClient({ ...memberRows[0], app_user_id: user.id }),
    };
  });
}

// the invited person declines (public — the token itself proves possession)
async function declineInvitation(code, ip) {
  return transaction(async (client) => {
    const invite = await lockAcceptableInvitation(client, code);
    await client.query(
      `UPDATE gym_member_invites SET status = 'DECLINED', updated_at = now() WHERE id = $1`,
      [invite.id]
    );
    await client.query(
      `UPDATE gym_members SET app_invite_status = 'none', updated_at = now() WHERE id = $1`,
      [invite.member_id]
    );
    await gymAudit(client, {
      gymId: invite.gym_id, actorLabel: `invited: ${invite.email}`, ip,
      action: 'member.invite_declined', entity: 'gym_member', entityId: invite.member_id,
    });
    return { ok: true };
  });
}

// Scenario 2: the person has NO app account. Registration happens THROUGH
// the invitation token — the new User is created AND linked atomically,
// so the historical GymMember record is connected, never duplicated.
async function registerViaInvitation(code, ip, { name, password }) {
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  if (!password || String(password).length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(String(password), 11);
  return transaction(async (client) => {
    const invite = await lockAcceptableInvitation(client, code);
    const emailNorm = String(invite.email).toLowerCase();
    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE lower(email) = $1', [emailNorm]
    );
    if (existing.length) {
      // registration failure must leave NO partial rows — user exists →
      // they should log in and accept instead
      throw new HttpError(409,
        'An account with this email already exists. Sign in with it to accept the invitation.');
    }
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'user') RETURNING id, email, name`,
      [emailNorm, passwordHash, String(name).trim()]
    );
    const user = userRows[0];
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [invite.member_id, invite.gym_id]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].app_user_id) {
      throw new HttpError(409, 'This member is already connected to an app account');
    }
    await client.query(
      `UPDATE gym_members SET app_user_id = $2, app_invite_status = 'none', updated_at = now()
       WHERE id = $1`,
      [memberRows[0].id, user.id]
    );
    await client.query(
      `UPDATE gym_member_invites SET status = 'ACCEPTED', accepted_at = now(),
         accepted_user_id = $2, updated_at = now() WHERE id = $1`,
      [invite.id, user.id]
    );
    await gymAudit(client, {
      gymId: invite.gym_id, actorUserId: user.id, ip,
      action: 'member.invite_accepted', entity: 'gym_member', entityId: memberRows[0].id,
      after: { registered_via_invitation: true, app_user_id: user.id },
    });
    return {
      ok: true,
      gymName: invite.gym_name,
      user: { id: user.id, email: user.email, name: user.name },
      member: memberToClient({ ...memberRows[0], app_user_id: user.id }),
    };
  });
}

// ── audit read ───────────────────────────────────────────────────────────
async function listAuditLog(gymId, { limit = 100, offset = 0, action } = {}) {
  const vals = [gymId];
  const where = ['gym_id = $1'];
  if (action) { vals.push(action); where.push(`action = $${vals.length}`); }
  const limitSql = `LIMIT ${Math.min(Number(limit) || 100, 500)}`;
  const offsetSql = `OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC ${limitSql} ${offsetSql}`,
    vals
  );
  return rows;
}

module.exports = {
  GYM_ROLES, WEEK_DAYS,
  createGym, listGymsForStaff, getGymById, updateGym, gymProfileCompletion, setGymLogo,
  leaveGym, deactivateGym, reactivateGym,
  listGymStaff, addGymStaff, updateGymStaff,
  createGymMember, listGymMembers, getGymMember, updateGymMember,
  cancelGymMember, reactivateGymMember, inviteMemberApp, cancelMemberInvite,
  getInvitationByToken, acceptInvitation, declineInvitation, registerViaInvitation,
  linkMemberToApp, unlinkMemberFromApp, listGymMembershipsForUser,
  listAuditLog, gymAudit,
};
