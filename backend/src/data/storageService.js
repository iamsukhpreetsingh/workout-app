// // Storage abstraction for user file backups (System 4). EVERY disk-path
// // assumption in the entire backend lives in this one file — swapping to
// // S3/Supabase Storage later means changing only this module. No route or
// // data module may touch the file system directly.
// const fs = require('fs');
// const path = require('path');

// // Files land under backend/uploads/progress-photos/<user_id>/<filename> and
// // are served by the existing static route (app.use('/uploads', ...)) in
// // server.js — no new route registration needed.
// const ROOT = path.join(__dirname, '..', '..', 'uploads', 'progress-photos');

// async function upload(fileBuffer, key) {
//   const dest = path.join(ROOT, key);
//   fs.mkdirSync(path.dirname(dest), { recursive: true });
//   fs.writeFileSync(dest, fileBuffer);
//   return key;
// }

// async function remove(key) {
//   try {
//     fs.unlinkSync(path.join(ROOT, key));
//   } catch {
//     // already gone — idempotent by convention
//   }
// }

// function getUrl(req, key) {
//   return `${req.protocol}://${req.get('host')}/uploads/progress-photos/${key}`;
// }

// module.exports = { upload, remove, getUrl };


// Storage abstraction — the ONLY module that knows where files live.
// S3-primary with deterministic local fallback (spec §34–49):
//   S3 configured + upload succeeds   → s3,   key stored
//   S3 not configured / upload fails  → local, key stored (persistent —
//   never /tmp; survives restarts; auto-created if deleted)
// Progress-photo business logic never learns which provider is live.
//
// SECURITY: nothing under progress-photos/ is served statically — bytes
// stream ONLY through /progress-photos/:id/image after authorization.
// S3 objects are private, accessed via short-lived signed URLs minted
// after the same checks. (Dish photos keep the public /uploads path —
// catalog content, not private user data.)
//
// LEGACY COMPAT: remove() also accepts a bare string key and getUrl() is
// retained because the old /user/backup/progress-photos routes (still live
// until the mobile Phase 2 rewire) call them. Those routes' returned URLs
// now 403 through the static guard — intentional transitional state.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'uploads');
const PROGRESS_ROOT = path.join(ROOT, 'progress-photos');

function ensureLocalDir() {
  fs.mkdirSync(PROGRESS_ROOT, { recursive: true });
}
ensureLocalDir(); // auto-create at startup AND re-checked on every upload

// ── provider detection (deterministic, spec §49) ───────────────────────
let s3Client = null;
let s3Bucket = null;
let s3Cmds = null;

function s3Configured() {
  return !!(
    process.env.STORAGE_PROVIDER === 's3' &&
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET
  );
}

function getS3() {
  if (!s3Configured()) return null;
  if (!s3Client) {
    try {
      const {
        S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
      } = require('@aws-sdk/client-s3'); // optional runtime dep — lazy
      s3Bucket = process.env.AWS_S3_BUCKET;
      s3Client = new S3Client({ region: process.env.AWS_REGION });
      s3Cmds = { GetObjectCommand, PutObjectCommand, DeleteObjectCommand };
    } catch {
      return null; // SDK not installed → local-only deployment
    }
  }
  return s3Client;
}

// upload(buffer, key, contentType) → { provider: 's3'|'local', key }
// S3 failure logs (name only — never secrets, spec §40) and falls back to
// local; the caller succeeds whenever either store persisted the bytes.
async function upload(buffer, key, contentType = 'image/jpeg') {
  const s3 = getS3();
  if (s3) {
    try {
      await s3.send(new s3Cmds.PutObjectCommand({
        Bucket: s3Bucket, Key: key, Body: buffer, ContentType: contentType,
      }));
      return { provider: 's3', key };
    } catch (e) {
      console.error(
        `[ProgressPhotoStorage] S3 upload failed (key=${key}): ${e.name || 'Error'} — falling back to local storage`
      );
    }
  }
  ensureLocalDir();
  const dest = path.join(PROGRESS_ROOT, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { provider: 'local', key };
}

// getStream({storage_provider, storage_key}) → { stream, provider } | null
// null = file missing (spec §46 case 6 — caller returns "no longer
// available", never a crash). S3 records stream via GetObject.
async function getStream({ storage_provider, storage_key }) {
  if (storage_provider === 's3') {
    const s3 = getS3();
    if (!s3) return null;
    try {
      const out = await s3.send(new s3Cmds.GetObjectCommand({
        Bucket: s3Bucket, Key: storage_key,
      }));
      return { stream: out.Body, provider: 's3' };
    } catch (e) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  }
  const p = path.join(PROGRESS_ROOT, storage_key);
  if (!fs.existsSync(p)) return null;
  return { stream: fs.createReadStream(p), provider: 'local' };
}

// Signed URL for S3 records — only minted AFTER the caller authorized the
// request (spec §43). Local records return null (always via the
// authorized image endpoint instead).
async function getSignedUrl(record, expiresSeconds = 300) {
  if (record.storage_provider !== 's3') return null;
  const s3 = getS3();
  if (!s3) return null;
  try {
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return await getSignedUrl(
      s3,
      new s3Cmds.GetObjectCommand({ Bucket: s3Bucket, Key: record.storage_key }),
      { expiresIn: expiresSeconds }
    );
  } catch (e) {
    console.error(`[ProgressPhotoStorage] signed URL failed: ${e.name || 'Error'}`);
    return null;
  }
}

// remove() — idempotent. Accepts the NEW record object
// ({storage_provider, storage_key}) OR a legacy bare-string key (the old
// backup route passes a string; treated as local).
async function remove(keyOrRecord) {
  const record = typeof keyOrRecord === 'string'
    ? { storage_provider: 'local', storage_key: keyOrRecord }
    : (keyOrRecord || {});
  if (record.storage_provider === 's3') {
    const s3 = getS3();
    if (s3) {
      try {
        await s3.send(new s3Cmds.DeleteObjectCommand({
          Bucket: s3Bucket, Key: record.storage_key,
        }));
      } catch (e) {
        console.error(`[ProgressPhotoStorage] S3 delete failed (key=${record.storage_key}): ${e.name || 'Error'}`);
        // record deletion proceeds; orphaned object logged, not fatal
      }
    }
    return;
  }
  try {
    fs.unlinkSync(path.join(PROGRESS_ROOT, record.storage_key));
  } catch {
    // already gone — idempotent by convention
  }
}

// LEGACY: used by the old backup photo routes during the Phase 2 transition
function getUrl(req, key) {
  return `${req.protocol}://${req.get('host')}/uploads/progress-photos/${key}`;
}

function localPathExists(key) {
  return fs.existsSync(path.join(PROGRESS_ROOT, key));
}

module.exports = { upload, getStream, getSignedUrl, remove, getUrl, localPathExists, s3Configured };