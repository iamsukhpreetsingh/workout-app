// gymMemberDocuments.js — gym member documents & digital waivers (Phase 18).
//
// A document belongs to a GymMember — NEVER directly to a User. The front
// desk files paperwork (liability waivers, membership agreements, ID
// verification, medical clearance) for members who have no app account at
// all (app_user_id NULL); when the member later connects to the app the
// rows do not move — they are simply reachable from the member's own
// /my endpoints, because they were keyed by member id all along.
//
// SECURITY MODEL (the strictest in the codebase — this is the member's
// most sensitive data: ID scans, medical clearances):
//   private        bytes live under uploads/gym-documents/ (or private
//                  S3). The static guard in server.js 403s the whole
//                  subtree — nothing is ever served without a JWT.
//   unguessable    storage keys are random UUIDs — no member id, category
//                  or sequence. The API never returns storage internals;
//                  downloads go through authorized endpoints only.
//   validated      every upload is size-capped (8MB), MIME-whitelisted
//                  (PDF/PNG/JPEG), extension-consistent AND sniffed by
//                  magic bytes — a renamed .exe or a polyglot text file
//                  is rejected, not stored. Filenames are sanitized to a
//                  bare, control-char-free name (no path traversal).
//   authorized     staff need documents.manage AND their branch
//                  restriction must cover the member's home branch;
//                  members reach only their own live documents.
//   audited        every DOWNLOAD (staff or member) lands in
//                  gym_document_download_log; lifecycle changes land in
//                  the gym audit log.
//
// LIFECYCLE
//   PENDING → AUTHORIZED   signed in-app (member types their name) or the
//                          desk records an on-paper signature
//   PENDING/AUTHORIZED → REPLACED   a new upload of the same category
//                          supersedes the old version (replaced_by);
//                          enforced by a partial unique index — one live
//                          document per category per member, race-proof
//   PENDING/AUTHORIZED → REVOKED    staff withdraw a bad upload
//   expiry is COMPUTED on read (effective_status EXPIRED) — the clock
//   never rewrites stored history; expired documents cannot be signed.
//   A member who leaves (status CANCELLED) keeps every document for
//   retention, but can no longer receive new paperwork or sign.
const { pool, query, transaction } = require('../db/pool');
const crypto = require('crypto');
const storage = require('./storageService');
const branches = require('./gymBranches');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── upload validation constants ───────────────────────────────────────────
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 8MB raw (≈10.7MB base64 — inside the 12mb JSON body limit)

const CONTENT_TYPES = storage.GYM_DOC_CONTENT_TYPES; // { 'application/pdf': '.pdf', ... }
const EXT_BY_MIME = CONTENT_TYPES;
const MAGIC = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('binary') === '%PDF-' },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

const CATEGORIES = {
  WAIVER: 'Liability Waiver',
  MEMBERSHIP_AGREEMENT: 'Membership Agreement',
  ID_VERIFICATION: 'ID Verification',
  MEDICAL_CLEARANCE: 'Medical Clearance',
  OTHER: 'Other Document',
};
const CATEGORY_KEYS = Object.keys(CATEGORIES);

const DOC_STATUSES = ['PENDING', 'AUTHORIZED', 'REPLACED', 'REVOKED'];
const LIVE_STATUSES = ['PENDING', 'AUTHORIZED'];
// statuses a member row may hold for paperwork to move (upload/sign) —
// everything else (PENDING/EXPIRED/CANCELLED member) is retention-only
const PAPERWORK_MEMBER_STATUSES = ['ACTIVE', 'FROZEN'];

const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── validation helpers ────────────────────────────────────────────────────

function assertCategoryId(category) {
  if (!CATEGORY_KEYS.includes(category)) {
    throw new HttpError(400, `category must be one of: ${CATEGORY_KEYS.join(', ')}`);
  }
  return category;
}

// Filenames are display metadata ONLY — the stored key is generated
// server-side — but they still get sanitized before storage so a crafted
// name can never traverse, smuggle control characters or overflow.
function sanitizeFilename(raw) {
  const base = String(raw || '')
    // strip every path separator and drive prefix (windows + posix)
    .split(/[/\\]+/).pop()
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '') // control chars + filesystem-hostile glyphs
    .trim()
    .slice(0, 120);
  return base || null;
}

// The extension must agree with the declared type; the magic bytes must
// agree with both. Returns the sniffed mime.
function sniffAndValidateContent(buffer, contentType) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!EXT_BY_MIME[mime]) {
    throw new HttpError(415, `Unsupported file type "${mime || 'unknown'}" — allowed: PDF, PNG, JPEG`);
  }
  const sniffed = MAGIC.find((m) => m.test(buffer));
  if (!sniffed) {
    throw new HttpError(400, `File content does not look like a valid ${mime === 'application/pdf' ? 'PDF' : 'image'} — upload rejected`);
  }
  if (sniffed.mime !== mime) {
    throw new HttpError(400, 'File content does not match the declared content type — upload rejected');
  }
  return mime;
}

// base64 → Buffer with the size cap enforced BOTH before decode (cheap,
// catches absurd payloads early) and after (the only honest number).
function decodeUpload(contentBase64) {
  const b64 = String(contentBase64 || '');
  if (!b64) throw new HttpError(400, 'content_base64 is required');
  const compact = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!BASE64_RE.test(compact)) throw new HttpError(400, 'content_base64 must be base64');
  // ceil(n/4)*3 upper bound — reject before allocating anything huge
  if ((compact.length / 4) * 3 > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, `File too large — maximum is ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB`);
  }
  const buffer = Buffer.from(compact, 'base64');
  if (!buffer.length) throw new HttpError(400, 'content_base64 decodes to an empty file');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, `File too large — maximum is ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB`);
  }
  return buffer;
}

function assertExpiresAt(v) {
  if (v === undefined || v === null || v === '') return null;
  let d;
  if (DATE_ONLY_RE.test(String(v))) {
    d = new Date(`${v}T23:59:59.000Z`); // "valid until <date>" = through end of that day (UTC)
  } else {
    d = new Date(v);
  }
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'expires_at must be a valid date or ISO timestamp');
  if (d.getTime() <= Date.now()) throw new HttpError(400, 'expires_at must be in the future');
  return d.toISOString();
}

function assertSignature(name) {
  const s = String(name || '').trim().slice(0, 80);
  if (!s) throw new HttpError(400, 'signature_name is required to authorize a document');
  return s;
}

// ── read shaping ──────────────────────────────────────────────────────────

function isExpired(row) {
  return !!(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
}

function effectiveStatus(row) {
  if (row.status === 'PENDING' && isExpired(row)) return 'EXPIRED';
  if (row.status === 'AUTHORIZED' && isExpired(row)) return 'EXPIRED';
  return row.status;
}

// storage internals NEVER reach the client — just the authorized path the
// frontend prefixes with the API URL and calls with its auth header.
function downloadPath(row, { memberScoped }) {
  return memberScoped
    ? `/gym/my/documents/${row.id}/file`
    : `/gym/${row.gym_id}/members/${row.member_id}/documents/${row.id}/file`;
}

function toClient(row, { memberScoped = false } = {}) {
  if (!row) return row;
  return {
    id: row.id,
    gym_id: row.gym_id,
    member_id: row.member_id,
    gym_name: row.gym_name ?? undefined,
    category: row.category,
    category_label: CATEGORIES[row.category] || row.category,
    title: row.title,
    status: row.status,
    effective_status: effectiveStatus(row),
    expired: isExpired(row),
    is_live: LIVE_STATUSES.includes(row.status),
    original_filename: row.original_filename,
    content_type: row.content_type,
    file_size: row.file_size,
    file_sha256: row.file_sha256,
    expires_at: row.expires_at,
    authorized_at: row.authorized_at,
    authorized_signature: row.authorized_signature ?? undefined,
    uploaded_via: row.uploaded_via,
    uploaded_by: row.uploaded_by,
    replaced_by: row.replaced_by,
    created_at: row.created_at,
    download_path: downloadPath(row, { memberScoped }),
  };
}

// ── shared guards ─────────────────────────────────────────────────────────

// Staff branch restriction (Phase 16): a desk/admin restricted to Mohali
// cannot read the paperwork of a member whose home branch is elsewhere.
// Unrestricted staff (OWNER always; others without branch_ids) pass, and
// legacy members without a home branch are reachable from anywhere.
async function assertStaffBranchScope(gymId, userId, member) {
  const allowed = await branches.staffBranchIds(gymId, userId);
  if (!allowed || !member.primary_branch_id) return;
  if (!allowed.includes(String(member.primary_branch_id))) {
    throw new HttpError(403, 'This member\u2019s home branch is outside your assigned branches');
  }
}

function assertMemberExists(member) {
  if (!member) throw new HttpError(404, 'Member not found');
}

// paperwork moves (upload/authorize/sign) only while the member is on the
// roster — a member who left keeps their file, but nothing new goes in
function assertMemberCanReceivePaperwork(member) {
  if (!PAPERWORK_MEMBER_STATUSES.includes(member.status)) {
    throw new HttpError(409, member.status === 'CANCELLED'
      ? 'This member has left the gym — their documents are retained but no new paperwork can be added'
      : `Membership is ${member.status.toLowerCase()} — paperwork can only be added for active members`);
  }
}

async function logDownload(client, row, actor, ip) {
  await client.query(
    `INSERT INTO gym_document_download_log (gym_id, document_id, actor_kind, actor_user_id, actor_label, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.gym_id, row.id, actor.kind, actor.userId ?? null, actor.label ?? null, ip ?? null]
  );
}

// ── staff surface (front desk / admin / owner) ────────────────────────────

async function listMemberDocuments(gymId, memberId, actor) {
  if (!UUID_RE.test(String(memberId || ''))) throw new HttpError(404, 'Member not found');
  const { rows: memberRows } = await query(
    'SELECT id, member_code, first_name, last_name, status, primary_branch_id FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  const member = memberRows[0];
  assertMemberExists(member);
  await assertStaffBranchScope(gymId, actor.userId, member);
  const { rows } = await query(
    `SELECT d.*, u.name AS uploaded_by_name
     FROM gym_member_documents d
     LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.gym_id = $1 AND d.member_id = $2
     ORDER BY d.created_at DESC`,
    [gymId, memberId]
  );
  return {
    member: {
      id: member.id, member_code: member.member_code,
      first_name: member.first_name, last_name: member.last_name, status: member.status,
      paperwork_allowed: PAPERWORK_MEMBER_STATUSES.includes(member.status),
    },
    documents: rows.map((r) => toClient(r)),
  };
}

// Upload a document for a member (desk works for members WITHOUT an app
// account). A live document of the same category is superseded (REPLACED,
// replaced_by → the new row) — one live document per category, enforced
// by a partial unique index so even a race cannot leave two live copies.
async function uploadDocument(gymId, memberId, { actor, ip }, payload, gymAudit) {
  if (!UUID_RE.test(String(memberId || ''))) throw new HttpError(404, 'Member not found');
  const category = assertCategoryId(payload.category);
  const title = sanitizeFilename(payload.title);
  if (payload.title && !title) throw new HttpError(400, 'title is invalid');
  const expiresAt = assertExpiresAt(payload.expires_at);

  const buffer = decodeUpload(payload.content_base64);
  const contentType = sniffAndValidateContent(buffer, payload.content_type);
  const originalFilename = sanitizeFilename(payload.filename)
    || `document${EXT_BY_MIME[contentType]}`;

  // bytes persist BEFORE the transaction; a failed tx cleans them up
  const ext = EXT_BY_MIME[contentType];
  const key = `${gymId}/${crypto.randomUUID()}${ext}`;
  const stored = await storage.uploadGymDocument(buffer, key, contentType);

  try {
    return await transaction(async (client) => {
      const { rows: memberRows } = await client.query(
        'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
        [memberId, gymId]
      );
      const member = memberRows[0];
      assertMemberExists(member);
      await assertStaffBranchScope(gymId, actor.userId, member);
      assertMemberCanReceivePaperwork(member);

      // supersede the current live document of this category (if any)
      const { rows: superseded } = await client.query(
        `UPDATE gym_member_documents SET status = 'REPLACED', updated_at = now()
         WHERE member_id = $1 AND category = $2 AND status IN ('PENDING','AUTHORIZED')
         RETURNING id`,
        [memberId, category]
      );

      const { rows } = await client.query(
        `INSERT INTO gym_member_documents
           (gym_id, member_id, category, title, status, storage_provider, storage_key,
            original_filename, content_type, file_size, file_sha256, expires_at,
            uploaded_by, uploaded_via)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10,$11,$12,'DESK')
         RETURNING *`,
        [gymId, memberId, category, title, stored.provider, stored.key,
         originalFilename, contentType, buffer.length,
         crypto.createHash('sha256').update(buffer).digest('hex'),
         expiresAt, actor.userId ?? null]
      );
      if (superseded.length) {
        await client.query(
          'UPDATE gym_member_documents SET replaced_by = $1, updated_at = now() WHERE id = ANY($2::uuid[])',
          [rows[0].id, superseded.map((r) => r.id)]
        );
      }
      await gymAudit(client, {
        gymId, actorUserId: actor.userId ?? null, actorLabel: actor.label ?? null, ip,
        action: 'document.uploaded', entity: 'gym_member_document', entityId: rows[0].id,
        before: superseded.length ? { superseded: superseded.map((r) => r.id) } : null,
        after: { category, filename: originalFilename, size: buffer.length,
                 status: 'PENDING', member_id: memberId },
      });
      return toClient(rows[0]);
    });
  } catch (e) {
    await storage.removeGymDocument(stored); // tx failed — no orphaned bytes
    if (e.code === '23505') {
      throw new HttpError(409, 'Another upload for this category is already in progress — retry');
    }
    throw e;
  }
}

async function getMemberDocument(gymId, memberId, documentId, actor) {
  if (!UUID_RE.test(String(documentId || ''))) throw new HttpError(404, 'Document not found');
  const { rows: memberRows } = await query(
    'SELECT id, primary_branch_id FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  const member = memberRows[0];
  assertMemberExists(member);
  await assertStaffBranchScope(gymId, actor.userId, member);
  const { rows } = await query(
    'SELECT * FROM gym_member_documents WHERE id = $1 AND gym_id = $2 AND member_id = $3',
    [documentId, gymId, memberId]
  );
  if (!rows.length) throw new HttpError(404, 'Document not found');
  const { rows: downloads } = await query(
    `SELECT actor_kind, actor_label, actor_user_id, ip, created_at
     FROM gym_document_download_log WHERE document_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [documentId]
  );
  return { ...toClient(rows[0]), download_history: downloads };
}

// THE authorized byte stream for staff. Permission was checked by the
// route; here we re-verify scope (branch), record the sensitive access,
// then hand back the stream. Returns null when bytes went missing (410).
async function streamMemberDocument(gymId, memberId, documentId, { actor, ip }) {
  if (!UUID_RE.test(String(documentId || ''))) throw new HttpError(404, 'Document not found');
  const { rows: memberRows } = await query(
    'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2',
    [memberId, gymId]
  );
  const member = memberRows[0];
  assertMemberExists(member);
  await assertStaffBranchScope(gymId, actor.userId, member);

  const { rows } = await query(
    'SELECT * FROM gym_member_documents WHERE id = $1 AND gym_id = $2 AND member_id = $3',
    [documentId, gymId, memberId]
  );
  if (!rows.length) throw new HttpError(404, 'Document not found');
  const doc = rows[0];

  // record BEFORE bytes move — a download that cannot be logged is a
  // download that must not happen
  await logDownload(pool, doc, actor, ip);

  const result = await storage.getGymDocumentStream(doc, doc.content_type);
  if (!result) return null;
  return { ...result, filename: doc.original_filename, fileSize: doc.file_size };
}

// Desk records a signature captured on paper: PENDING → AUTHORIZED.
async function authorizeMemberDocument(gymId, memberId, documentId, { actor, ip }, payload, gymAudit) {
  const signature = assertSignature(payload.signature_name);
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    const member = memberRows[0];
    assertMemberExists(member);
    await assertStaffBranchScope(gymId, actor.userId, member);
    const { rows } = await client.query(
      'SELECT * FROM gym_member_documents WHERE id = $1 AND member_id = $2 AND gym_id = $3 FOR UPDATE',
      [documentId, memberId, gymId]
    );
    const doc = rows[0];
    if (!doc) throw new HttpError(404, 'Document not found');
    assertMemberCanReceivePaperwork(member);
    if (doc.status !== 'PENDING') {
      throw new HttpError(409, doc.status === 'AUTHORIZED'
        ? 'This document is already authorized'
        : `A ${doc.status.toLowerCase()} document cannot be authorized`);
    }
    if (isExpired(doc)) throw new HttpError(409, 'This document has expired — upload a fresh copy instead');
    const { rows: updated } = await client.query(
      `UPDATE gym_member_documents
       SET status = 'AUTHORIZED', authorized_at = now(), authorized_by = $1, authorized_signature = $2,
           updated_at = now()
       WHERE id = $3 RETURNING *`,
      [actor.userId ?? null, signature, documentId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor.userId ?? null, actorLabel: actor.label ?? null, ip,
      action: 'document.authorized', entity: 'gym_member_document', entityId: documentId,
      before: { status: 'PENDING' },
      after: { status: 'AUTHORIZED', signature_name: signature, by: 'DESK' },
    });
    return toClient(updated[0]);
  });
}

async function revokeMemberDocument(gymId, memberId, documentId, { actor, ip }, payload, gymAudit) {
  const reason = payload && payload.reason ? String(payload.reason).trim().slice(0, 300) : null;
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM gym_member_documents WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE',
      [documentId, gymId, memberId]
    );
    const doc = rows[0];
    if (!doc) throw new HttpError(404, 'Document not found');
    if (!LIVE_STATUSES.includes(doc.status)) {
      throw new HttpError(409, `A ${doc.status.toLowerCase()} document cannot be revoked`);
    }
    const { rows: updated } = await client.query(
      `UPDATE gym_member_documents SET status = 'REVOKED', updated_at = now() WHERE id = $1 RETURNING *`,
      [documentId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor.userId ?? null, actorLabel: actor.label ?? null, ip,
      action: 'document.revoked', entity: 'gym_member_document', entityId: documentId,
      before: { status: doc.status }, after: { status: 'REVOKED', reason },
    });
    return toClient(updated[0]);
  });
}

// ── member surface (the app; member resolved from the JWT) ────────────────

// Every document across the caller's ACTIVE gym memberships. A member who
// left a gym (CANCELLED) loses app visibility of that file set — retention
// is the gym's staff-side concern. Includes REPLACED/REVOKED rows so the
// member sees their document history, flagged is_live=false.
async function listMyDocuments(userId) {
  const { rows } = await query(
    `SELECT d.*, g.name AS gym_name
     FROM gym_members m
     JOIN gyms g ON g.id = m.gym_id AND g.status = 'ACTIVE'
     JOIN gym_member_documents d ON d.member_id = m.id AND d.gym_id = m.gym_id
     WHERE m.app_user_id = $1 AND m.status = 'ACTIVE'
     ORDER BY d.created_at DESC`,
    [userId]
  );
  return rows.map((r) => toClient(r, { memberScoped: true }));
}

async function findMyDocument(userId, documentId) {
  if (!UUID_RE.test(String(documentId || ''))) throw new HttpError(404, 'Document not found');
  const { rows } = await query(
    `SELECT d.*, m.status AS member_status
     FROM gym_member_documents d
     JOIN gym_members m ON m.id = d.member_id
     WHERE d.id = $1 AND m.app_user_id = $2`,
    [documentId, userId]
  );
  if (!rows.length) throw new HttpError(404, 'Document not found'); // never confirm other members' documents
  return rows[0];
}

// The member's own byte stream — live documents only. Every read is logged.
async function streamMyDocument(userId, documentId, { actor, ip }) {
  const doc = await findMyDocument(userId, documentId);
  if (doc.member_status !== 'ACTIVE') throw new HttpError(403, 'Your membership is not active');
  if (!LIVE_STATUSES.includes(doc.status)) {
    throw new HttpError(409, `This document is ${doc.status.toLowerCase()} and no longer available`);
  }
  await logDownload(pool, doc, actor, ip);
  const result = await storage.getGymDocumentStream(doc, doc.content_type);
  if (!result) return null;
  return { ...result, filename: doc.original_filename, fileSize: doc.file_size };
}

// Digital waiver signing: the member types their legal name — PENDING →
// AUTHORIZED with the typed signature retained on the row. Expired
// documents refuse: the gym needs a fresh copy, not a stale signature.
async function signMyDocument(userId, documentId, { actor, ip }, payload, gymAudit) {
  const signature = assertSignature(payload && payload.signature_name);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT d.*, m.status AS member_status FROM gym_member_documents d
       JOIN gym_members m ON m.id = d.member_id
       WHERE d.id = $1 AND m.app_user_id = $2 FOR UPDATE OF d`,
      [documentId, userId]
    );
    const memberStatus = rows[0]?.member_status;
    const doc = rows[0];
    if (!doc) throw new HttpError(404, 'Document not found');
    if (memberStatus !== 'ACTIVE') throw new HttpError(403, 'Your membership is not active');
    if (doc.status !== 'PENDING') {
      throw new HttpError(409, doc.status === 'AUTHORIZED'
        ? 'You have already signed this document'
        : `A ${doc.status.toLowerCase()} document cannot be signed`);
    }
    if (isExpired(doc)) throw new HttpError(409, 'This document has expired — ask the gym for a fresh copy');

    const { rows: updated } = await client.query(
      `UPDATE gym_member_documents
       SET status = 'AUTHORIZED', authorized_at = now(), authorized_by = $1, authorized_signature = $2,
           updated_at = now()
       WHERE id = $3 RETURNING *`,
      [actor.userId ?? null, signature, documentId]
    );
    await gymAudit(client, {
      gymId: doc.gym_id, actorUserId: actor.userId ?? null, actorLabel: actor.label ?? null, ip,
      action: 'document.signed', entity: 'gym_member_document', entityId: documentId,
      before: { status: 'PENDING' },
      after: { status: 'AUTHORIZED', signature_name: signature, by: 'APP' },
    });
    return toClient(updated[0], { memberScoped: true });
  });
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, MAX_DOCUMENT_BYTES, LIVE_STATUSES,
  sanitizeFilename, decodeUpload, sniffAndValidateContent, assertExpiresAt,
  effectiveStatus, isExpired, toClient,
  listMemberDocuments, uploadDocument, getMemberDocument,
  streamMemberDocument, authorizeMemberDocument, revokeMemberDocument,
  listMyDocuments, streamMyDocument, signMyDocument,
};
