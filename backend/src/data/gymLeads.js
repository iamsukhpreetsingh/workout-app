// gymLeads.js — Leads / Visitors / Trial registration via the public QR.
//
// Two hard separations this module enforces:
//   1. LEAD QR ≠ ATTENDANCE QR. The lead secret lives under its OWN
//      gyms.settings key ('lead_qr_code'), its payload is typed
//      `gymlead:v1:<code>` (vs the attendance `gymcheckin:v1:<code>`), and
//      every resolution here rejects attendance-shaped tokens. The
//      attendance check-in path likewise rejects lead-shaped codes.
//   2. A LEAD IS NOT A MEMBER. Nothing here creates users, credentials or
//      gym_members rows. Conversion happens ONLY through the existing
//      member-creation flow, and merely back-links converted_member_id.
//
// The submission endpoint is PUBLIC (no auth): every input is validated
// server-side, submissions are rate-limited at the route, phone-format
// duplicates within a short window are deduped (double-tap protection), and
// a lead whose phone matches an existing member is flagged (matched_member_id)
// instead of blindly duplicating the person.
const crypto = require('crypto');
const { query, transaction, pool } = require('../db/pool');
const staffNotifications = require('./gymStaffNotifications');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LEAD_TYPES = ['ENQUIRY', 'TRIAL', 'VISITOR', 'MEMBERSHIP_ENQUIRY', 'GENERAL_ENQUIRY'];
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'TRIAL_SCHEDULED', 'TRIAL_COMPLETED',
  'JOINED', 'NOT_JOINED', 'NO_RESPONSE', 'FOLLOW_UP', 'CLOSED'];
const NAME_RE = /^[\p{L}\p{M}'.\- ]+$/u; // O'Connor, Mary-Jane, Gurpreet Singh all pass
const PHONE_RE = /^[0-9+\-()[\]\s]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// the same person submitting the same number twice within this window is a
// double-tap/retry, not a new enquiry
const DUP_WINDOW_MINUTES = 10;

// ── QR secret (mirrors the attendance check-in code, separate key) ───────

function newLeadQrCode() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit
}

function normalizeLeadToken(token) {
  const t = String(token || '').trim().toLowerCase().replace(/^gymlead:v1:/i, '');
  if (t.length < 8 || t.length > 128) return null;
  return t;
}

async function ensureLeadQrCode(gymId) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT settings->>'lead_qr_code' AS code FROM gyms WHERE id = $1 FOR UPDATE`,
      [gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Gym not found');
    if (rows[0].code) return rows[0].code;
    const code = newLeadQrCode();
    await client.query(
      `UPDATE gyms SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('lead_qr_code', $2::text),
         updated_at = now() WHERE id = $1`,
      [gymId, code]
    );
    return code;
  });
}

async function rotateLeadQrCode(gymId, actor, ip, gymAudit) {
  const code = newLeadQrCode();
  const { rows } = await query(
    `UPDATE gyms SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('lead_qr_code', $2::text),
       updated_at = now() WHERE id = $1 RETURNING id`,
    [gymId, code]
  );
  if (!rows.length) throw new HttpError(404, 'Gym not found');
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: 'gym.lead_qr_rotated', entity: 'gym', entityId: gymId,
    after: { note: 'old lead QR is now dead — old posters stop working' },
  });
  return code;
}

// ── public: landing + submit ──────────────────────────────────────────────

async function resolveGymByLeadToken(token) {
  const t = normalizeLeadToken(token);
  if (!t) return { state: 'INVALID' };
  // explicit type separation: an attendance QR must never open a lead form
  if (/^gymcheckin:v1:/i.test(String(token || '').trim())) return { state: 'INVALID' };
  const { rows } = await query(
    `SELECT id, name, city, status,
            COALESCE(settings->>'lead_capture_enabled', 'true') AS enabled
     FROM gyms WHERE settings->>'lead_qr_code' = $1`,
    [t]
  );
  if (!rows.length) return { state: 'INVALID' };
  const gym = rows[0];
  if (gym.status !== 'ACTIVE') return { state: 'GYM_UNAVAILABLE', gym };
  if (gym.enabled === 'false') return { state: 'DISABLED', gym };
  return { state: 'OK', gym };
}

async function getLeadLanding(token) {
  const r = await resolveGymByLeadToken(token);
  if (r.state === 'OK') {
    return { state: 'OK', gym_name: r.gym.name, city: r.gym.city || null, types: LEAD_TYPES };
  }
  // one safe external message for every failure shape (invalid / disabled /
  // suspended / deactivated) — never leak which one it is
  return { state: 'UNAVAILABLE' };
}

function validateLeadInput(data) {
  const full_name = String(data?.full_name || '').trim();
  if (!full_name) throw new HttpError(400, 'Please enter your name.');
  if (full_name.length > 80 || !NAME_RE.test(full_name)) {
    throw new HttpError(400, 'Please enter a valid name.');
  }
  const phone = String(data?.phone || '').trim();
  if (!phone) throw new HttpError(400, 'Please enter your mobile number.');
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7) {
    throw new HttpError(400, 'Please enter a valid mobile number.');
  }
  let email = String(data?.email || '').trim() || null;
  if (email) {
    if (email.length > 120 || !EMAIL_RE.test(email)) {
      throw new HttpError(400, 'Please enter a valid email address.');
    }
    email = email.toLowerCase();
  }
  const enquiry_type = String(data?.enquiry_type || 'ENQUIRY').toUpperCase();
  if (!LEAD_TYPES.includes(enquiry_type)) {
    throw new HttpError(400, 'Please pick a valid enquiry type.');
  }
  let preferred_visit_on = String(data?.preferred_visit_on || '').trim() || null;
  if (preferred_visit_on) {
    if (!DATE_RE.test(preferred_visit_on)) {
      throw new HttpError(400, 'Preferred visit date must be a YYYY-MM-DD date.');
    }
    const d = new Date(`${preferred_visit_on}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Preferred visit date is not a real date.');
  }
  const message = String(data?.message || '').trim().slice(0, 500) || null;
  return { full_name, phone, email, enquiry_type, preferred_visit_on, message };
}

async function submitLead(token, ip, data) {
  const r = await resolveGymByLeadToken(token);
  if (r.state !== 'OK') {
    // same safe answer whether the QR is dead, the gym suspended, or leads
    // turned off — and it never creates a lead
    throw new HttpError(404, 'This registration form is currently unavailable. Please contact the gym directly.');
  }
  const gym = r.gym;
  const v = validateLeadInput(data);

  // existing member with this phone? flag the lead — never create a second
  // member record just because a member used the lead QR
  const { rows: memberMatch } = await query(
    `SELECT id FROM gym_members
     WHERE gym_id = $1 AND btrim(phone) = $2 AND status <> 'CANCELLED'
     ORDER BY (status = 'ACTIVE') DESC LIMIT 1`,
    [gym.id, v.phone]
  );

  // double-tap / retry protection: same gym+phone within the window returns
  // the EXISTING lead instead of inserting a near-identical one
  const { rows: recent } = await query(
    `SELECT id FROM gym_leads
     WHERE gym_id = $1 AND btrim(phone) = $2
       AND created_at > now() - ($3::text || ' minutes')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [gym.id, v.phone, DUP_WINDOW_MINUTES]
  );
  if (recent.length) return { ok: true, duplicate: true, gym_name: gym.name };

  const { rows } = await query(
    `INSERT INTO gym_leads (gym_id, full_name, phone, email, enquiry_type, message,
       preferred_visit_on, matched_member_id, source, created_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'GYM_QR',$9) RETURNING id`,
    [gym.id, v.full_name, v.phone, v.email, v.enquiry_type, v.message,
     v.preferred_visit_on, memberMatch[0]?.id || null, ip || null]
  );
  staffNotifications.notifyStaff({
    gymId: gym.id, type: 'LEAD_RECEIVED',
    title: 'New lead received',
    message: `${v.full_name} submitted a ${v.enquiry_type === 'ENQUIRY' ? 'general enquiry' : v.enquiry_type.toLowerCase().replace('_', ' ')} via the gym QR code.`,
    entityType: 'LEAD', entityId: rows[0].id, memberId: memberMatch[0]?.id || null,
    dedupeKey: `lead_received:${rows[0].id}`,
  });
  return { ok: true, duplicate: false, gym_name: gym.name };
}

// ── staff: inbox + lifecycle ──────────────────────────────────────────────

const LEAD_SELECT = `l.id, l.gym_id, l.full_name, l.phone, l.email, l.enquiry_type,
  l.status, l.source, l.message, l.preferred_visit_on,
  l.matched_member_id, l.converted_member_id, l.created_at, l.updated_at,
  cm.first_name AS converted_first_name, cm.last_name AS converted_last_name,
  cm.member_code AS converted_member_code`;

function leadToClient(row) {
  return {
    ...row,
    converted_member: row.converted_member_id
      ? { id: row.converted_member_id, name: [row.converted_first_name, row.converted_last_name].filter(Boolean).join(' '), member_code: row.converted_member_code }
      : null,
    matched_member: row.matched_member_id
      ? { id: row.matched_member_id }
      : null,
  };
}

async function listLeads(gymId, { status, type, q, limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = ['l.gym_id = $1'];
  const vals = [gymId];
  if (status && LEAD_STATUSES.includes(status)) { vals.push(status); where.push(`l.status = $${vals.length}`); }
  if (type && LEAD_TYPES.includes(type)) { vals.push(type); where.push(`l.enquiry_type = $${vals.length}`); }
  if (q) {
    vals.push(`%${String(q).trim()}%`);
    where.push(`(l.full_name ILIKE $${vals.length} OR l.phone ILIKE $${vals.length}
                 OR COALESCE(l.email, '') ILIKE $${vals.length})`);
  }
  const { rows } = await query(
    `SELECT ${LEAD_SELECT},
       (SELECT COUNT(*)::int FROM gym_lead_notes n WHERE n.lead_id = l.id) AS note_count
     FROM gym_leads l
     LEFT JOIN gym_members cm ON cm.id = l.converted_member_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.created_at DESC
     LIMIT ${lim} OFFSET ${off}`,
    vals
  );
  return rows.map(leadToClient);
}

async function getLead(gymId, leadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId || '')) return null;
  const { rows } = await query(
    `SELECT ${LEAD_SELECT} FROM gym_leads l
     LEFT JOIN gym_members cm ON cm.id = l.converted_member_id
     WHERE l.id = $1 AND l.gym_id = $2`,
    [leadId, gymId]
  );
  if (!rows.length) return null;
  const notes = (await query(
    `SELECT n.id, n.note, n.created_at, u.name AS created_by_name
     FROM gym_lead_notes n LEFT JOIN users u ON u.id = n.created_by
     WHERE n.lead_id = $1 ORDER BY n.created_at DESC`,
    [leadId]
  )).rows;
  // lifecycle activity straight from the audit log (append-only source of truth)
  const activity = (await query(
    `SELECT a.action, a.created_at, a.actor_label, a.before, a.after
     FROM audit_logs a
     WHERE a.gym_id = $1 AND a.entity = 'gym_lead' AND a.entity_id = $2
     ORDER BY a.created_at ASC LIMIT 100`,
    [gymId, leadId]
  )).rows;
  return { ...leadToClient(rows[0]), notes, activity };
}

async function updateLeadStatus(gymId, leadId, actor, ip, status, gymAudit) {
  const s = String(status || '').toUpperCase();
  if (!LEAD_STATUSES.includes(s)) throw new HttpError(400, `status must be one of ${LEAD_STATUSES.join(', ')}`);
  const before = await query('SELECT status FROM gym_leads WHERE id = $1 AND gym_id = $2', [leadId, gymId]);
  if (!before.rows.length) throw new HttpError(404, 'Lead not found');
  const { rows } = await query(
    `UPDATE gym_leads SET status = $3, updated_at = now()
     WHERE id = $1 AND gym_id = $2 RETURNING *`,
    [leadId, gymId, s]
  );
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: 'lead.status_changed', entity: 'gym_lead', entityId: leadId,
    before: { status: before.rows[0].status }, after: { status: s },
  });
  return leadToClient(rows[0]);
}

async function addLeadNote(gymId, leadId, actor, ip, note, gymAudit) {
  const clean = String(note || '').trim();
  if (clean.length < 1 || clean.length > 500) {
    throw new HttpError(400, 'Note must be 1-500 characters');
  }
  const { rows: lead } = await query('SELECT id FROM gym_leads WHERE id = $1 AND gym_id = $2', [leadId, gymId]);
  if (!lead.length) throw new HttpError(404, 'Lead not found');
  const { rows } = await query(
    `INSERT INTO gym_lead_notes (lead_id, note, created_by) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [leadId, clean, actor?.userId ?? actor ?? null]
  );
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: 'lead.note_added', entity: 'gym_lead', entityId: leadId,
    after: { note: clean },
  });
  return { id: rows[0].id, note: clean, created_at: rows[0].created_at };
}

// explicit conversion: the gym FIRST creates the member through the existing
// members flow, then links that member to this lead (status → JOINED)
async function linkConvertedMember(gymId, leadId, memberId, actor, ip, gymAudit) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId || '')) {
    throw new HttpError(400, 'member_id is required');
  }
  const { rows: member } = await query(
    'SELECT id, first_name, last_name, member_code FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  if (!member.length) throw new HttpError(404, 'Member not found in this gym');
  const { rows } = await query(
    `UPDATE gym_leads SET converted_member_id = $3, status = 'JOINED', updated_at = now()
     WHERE id = $1 AND gym_id = $2 RETURNING *`,
    [leadId, gymId, memberId]
  );
  if (!rows.length) throw new HttpError(404, 'Lead not found');
  // re-fetch with the join so the response carries the converted member
  const fresh = await query(
    `SELECT ${LEAD_SELECT} FROM gym_leads l
     LEFT JOIN gym_members cm ON cm.id = l.converted_member_id
     WHERE l.id = $1 AND l.gym_id = $2`,
    [leadId, gymId]
  );
  await gymAudit(pool, {
    gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
    action: 'lead.converted', entity: 'gym_lead', entityId: leadId,
    after: { member_id: memberId, member_code: member[0].member_code },
  });
  return leadToClient(fresh.rows[0]);
}

module.exports = {
  LEAD_TYPES, LEAD_STATUSES,
  ensureLeadQrCode, rotateLeadQrCode,
  getLeadLanding, submitLead,
  listLeads, getLead, updateLeadStatus, addLeadNote, linkConvertedMember,
};
