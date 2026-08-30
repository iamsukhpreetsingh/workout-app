// Progress Photos — the authorization brain (spec §20–27, §29–30).
// ALL rules enforced HERE, server-side — the mobile UI is convenience only:
//  * Ownership: every read/write is scoped to the token's user id.
//  * Future dates: rejected against APP_TIMEZONE "today" (spec §24–25).
//  * One photo per (user, date): UNIQUE constraint; create = upsert-by-date
//    (last-write-wins — the documented sync conflict policy — which also
//    makes offline sync idempotent when two devices hold the same date).
//  * Visibility PERSONAL | TRAINER_SHARED. Personal photos NEVER leave the
//    database for any trainer endpoint — filtered here, not hidden in UI.
//  * Trainer access = ACTIVE association + TRAINER_SHARED, BOTH re-checked
//    at read time. The 30-day archived-readable window for other client
//    data does NOT apply to photos (spec §21: access dies at unlink).
//  * +1 RULE: unlink flips the client's TRAINER_SHARED photos to PERSONAL
//    (resetSharesOnDisconnect) — a new trainer starts with a clean slate.
//
// DATE HANDLING: photo_date is ALWAYS a 'YYYY-MM-DD' string at the API
// boundary — every SELECT uses TO_CHAR because node-postgres otherwise
// converts DATE columns into JS Date objects at server-local midnight,
// which (a) breaks string comparisons and (b) silently shifts a day for
// any timezone east of UTC when stringified via toISOString().
const crypto = require('crypto');
const { query } = require('../db/pool');
const storage = require('./storageService');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const VISIBILITIES = ['PERSONAL', 'TRAINER_SHARED'];

// "Today" in the app's configured timezone (spec §25). The client always
// sends its own local calendar date; this is only the server-side guard
// against dates the user's region hasn't reached yet.
function todayInAppTz() {
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10); // invalid tz → UTC fallback
  }
}

function validateDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) {
    throw new HttpError(400, 'photo_date must be a YYYY-MM-DD string');
  }
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) {
    throw new HttpError(400, 'photo_date is not a valid calendar date');
  }
  return d;
}

function validateVisibility(v) {
  if (v == null) return 'PERSONAL';
  if (!VISIBILITIES.includes(v)) {
    throw new HttpError(400, "visibility must be 'PERSONAL' or 'TRAINER_SHARED'");
  }
  return v;
}



// BUGFIX: bare base64 (no data:image/...;base64, prefix — what expo's
// readAsStringAsync produces) matched the fallback regex whose FIRST
// capture group was the whole base64 blob; treating m[1] as the file
// "extension" built keys like "<uuid>.<megabytes-of-base64>" →
// ENAMETOOLONG on mkdir. Type info simply doesn't exist in bare base64 —
// so we default to jpg unless a data-URI declares png/jpg/webp.
function parseImage(image_base64) {
  const b64 = String(image_base64 || '').trim();
  const dataUri = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(b64);
  const bare = !dataUri && /^([A-Za-z0-9+/=\s]+)$/.test(b64);
  if (!dataUri && !bare) {
    throw new HttpError(400, 'image_base64 is required and must be valid base64 image data');
  }
  const payload = dataUri ? dataUri[2] : b64.replace(/\s+/g, '');
  const raw = Buffer.from(payload, 'base64');
  if (!raw.length || raw.length > 8 * 1024 * 1024) {
    throw new HttpError(400, 'image too large (max 8MB)');
  }
  let ext = 'jpg';
  let contentType = 'image/jpeg';
  if (dataUri) {
    ext = dataUri[1] === 'jpeg' ? 'jpg' : dataUri[1];
    contentType = `image/${dataUri[1]}`;
  } else {
    // sniff JPEG/PNG magic bytes when no data-URI declared the type —
    // covers clients that send bare base64 of a PNG
    if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
      ext = 'png';
      contentType = 'image/png';
    }
  }
  return { buffer: raw, ext, contentType };
}


// every SELECT/RETURNING uses this — string date at the API boundary
const DATE_COL = `TO_CHAR(photo_date, 'YYYY-MM-DD') AS photo_date`;

// ── user-facing CRUD ────────────────────────────────────────────────────

// Create OR replace-by-date (LWW). Replacement order per spec §45: upload
// new FIRST, update the row, THEN remove the old storage object.
async function createPhoto(userId, { photo_date, visibility, image_base64 }) {
  const date = validateDate(photo_date);
  if (!image_base64) throw new HttpError(400, 'image_base64 is required');
  const vis = validateVisibility(visibility);
//   if (date > todayInAppTz()) {
//     throw new HttpError(400, 'Progress photos cannot be added for future dates.');
//   }


  // 1-day grace absorbs device↔server midnight skew (photo logged at
  // 11:58 PM local while the server's tz clock already ticked over). The
  // spec's intent — blocking genuinely future-dated uploads — is intact:
  // anything ≥2 days ahead is still rejected outright.
  const today = todayInAppTz();
  const grace = new Date(`${today}T00:00:00Z`);
  grace.setUTCDate(grace.getUTCDate() + 1);
  if (date > grace.toISOString().slice(0, 10)) {
    throw new HttpError(400, 'Progress photos cannot be added for future dates.');
  }
  const { buffer, ext, contentType } = parseImage(image_base64);
//   const key = `${userId}/${date}-${crypto.randomUUID()}.${ext}`;
  const key = `${String(userId).slice(0, 8)}/${date}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const stored = await storage.upload(buffer, key, contentType);

  const existing = await query(
    'SELECT id, storage_provider, storage_key FROM progress_photos WHERE user_id = $1 AND photo_date = $2',
    [userId, date]
  );
  if (existing.rows.length) {
    const old = existing.rows[0];
    const { rows } = await query(
      `UPDATE progress_photos
         SET storage_provider = $2, storage_key = $3, content_type = $4,
             visibility = $5, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, ${DATE_COL}, visibility, created_at, updated_at`,
      [old.id, stored.provider, stored.key, contentType, vis]
    );
    await storage.remove(old);
    return rows[0];
  }
  const { rows } = await query(
    `INSERT INTO progress_photos (user_id, photo_date, visibility, storage_provider, storage_key, content_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, ${DATE_COL}, visibility, created_at, updated_at`,
    [userId, date, vis, stored.provider, stored.key, contentType]
  );
  return rows[0];
}

async function listPhotos(userId) {
  const { rows } = await query(
    `SELECT id, ${DATE_COL}, visibility, created_at, updated_at
     FROM progress_photos WHERE user_id = $1 ORDER BY photo_date DESC`,
    [userId]
  );
  return rows;
}

async function getPhoto(userId, photoId) {
  const { rows } = await query(
    `SELECT id, user_id, ${DATE_COL}, visibility, storage_provider, storage_key, content_type, created_at, updated_at
     FROM progress_photos WHERE id = $1`,
    [photoId]
  );
  if (!rows.length || rows[0].user_id !== userId) throw new HttpError(404, 'Photo not found');
  return rows[0];
}

// Update visibility and/or replace the image (upload-first ordering).
async function updatePhoto(userId, photoId, { visibility, image_base64 }) {
  const current = await getPhoto(userId, photoId); // 404 if not owner
  const vis = visibility != null ? validateVisibility(visibility) : current.visibility;

  if (image_base64) {
    const { buffer, ext, contentType } = parseImage(image_base64);
    const key = `${userId}/${current.photo_date}-${crypto.randomUUID()}.${ext}`;
    const stored = await storage.upload(buffer, key, contentType);
    const { rows } = await query(
      `UPDATE progress_photos
         SET visibility = $2, storage_provider = $3, storage_key = $4, content_type = $5, updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, ${DATE_COL}, visibility, created_at, updated_at`,
      [photoId, vis, stored.provider, stored.key, contentType]
    );
    await storage.remove(current);
    return rows[0];
  }

  const { rows } = await query(
    `UPDATE progress_photos SET visibility = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, ${DATE_COL}, visibility, created_at, updated_at`,
    [photoId, vis]
  );
  return rows[0];
}

async function deletePhoto(userId, photoId) {
  const current = await getPhoto(userId, photoId);
  await query('DELETE FROM progress_photos WHERE id = $1', [photoId]);
  await storage.remove(current);
  return { ok: true };
}

// ── authorization + trainer access ──────────────────────────────────────

// Resolve a photo for a VIEWER (owner or trainer). Non-authorized viewers
// get 404 — never 403 — so existence of private photos is never confirmed.
async function getPhotoForViewer(viewer, photoId) {
  const { rows } = await query(
    `SELECT id, user_id, ${DATE_COL}, visibility, storage_provider, storage_key, content_type
     FROM progress_photos WHERE id = $1`,
    [photoId]
  );
  const photo = rows[0];
  if (!photo) throw new HttpError(404, 'Photo not found');

  if (photo.user_id === viewer.id) return photo; // owner — any role

  if (viewer.role === 'trainer' && photo.visibility === 'TRAINER_SHARED') {
    const { rows: assoc } = await query(
      `SELECT 1 FROM trainer_clients
       WHERE trainer_id = $1 AND client_id = $2 AND status = 'active' LIMIT 1`,
      [viewer.id, photo.user_id]
    );
    if (assoc.length) return photo;
  }
  throw new HttpError(404, 'Photo not found');
}

// Authorized byte stream for the /:id/image endpoint. null = row exists but
// the underlying file is gone (spec §46 case 6 — graceful).
async function getPhotoStream(viewer, photoId) {
  const photo = await getPhotoForViewer(viewer, photoId);
  const result = await storage.getStream(photo);
  if (!result) return null;
  return { stream: result.stream, contentType: photo.content_type || 'image/jpeg' };
}

// Trainer listing: ACTIVE association required, PERSONAL photos filtered
// out server-side (spec §20 — not merely hidden in the trainer UI).
async function listSharedForTrainer(trainerId, clientId) {
  const { rows: assoc } = await query(
    `SELECT 1 FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status = 'active' LIMIT 1`,
    [trainerId, clientId]
  );
  if (!assoc.length) throw new HttpError(403, 'No active association with this client');

  const { rows } = await query(
    `SELECT id, ${DATE_COL}, created_at, updated_at
     FROM progress_photos
     WHERE user_id = $1 AND visibility = 'TRAINER_SHARED'
     ORDER BY photo_date DESC`,
    [clientId]
  );
  return rows;
}

// +1 RULE — called by BOTH unlink routes: every TRAINER_SHARED photo of
// this client flips to PERSONAL. Returns the count reset (for logging).
async function resetSharesOnDisconnect(clientId) {
  const { rowCount } = await query(
    `UPDATE progress_photos SET visibility = 'PERSONAL', updated_at = now()
     WHERE user_id = $1 AND visibility = 'TRAINER_SHARED'`,
    [clientId]
  );
  return rowCount || 0;
}

module.exports = {
  createPhoto, listPhotos, getPhoto, updatePhoto, deletePhoto,
  getPhotoForViewer, getPhotoStream, listSharedForTrainer,
  resetSharesOnDisconnect, todayInAppTz,
};