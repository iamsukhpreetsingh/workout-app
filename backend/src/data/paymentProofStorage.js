// paymentProofStorage.js — storage abstraction for payment-proof
// screenshots (Phase M11). Financial evidence gets stricter handling than
// gym logos:
//
//   • S3-compatible storage is the PRODUCTION target; bucket/credentials
//     come exclusively from environment configuration (never source code).
//   • Local dev fallback writes under uploads/payment-proofs/ (configurable
//     via PAYMENT_PROOF_LOCAL_DIR) — but only OUTSIDE production. If
//     production runs without S3 configuration, uploads FAIL LOUDLY rather
//     than silently landing financial documents on ephemeral disk.
//   • Object names are generated (uuid + validated extension) — a
//     user-supplied filename never touches the storage path.
//   • Bytes come back only through the authorized route; nothing here
//     exposes public URLs.
const fs = require('fs');
const path = require('path');
const { s3Configured } = require('./storageService');

let s3Client = null;
let s3Bucket = null;
let s3Cmds = null;

function ensureS3() {
  if (s3Client) return true;
  if (!s3Configured()) return false;
  try {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    s3Bucket = process.env.PAYMENT_PROOF_STORAGE_BUCKET || process.env.AWS_S3_BUCKET;
    s3Client = new S3Client({ region: process.env.AWS_REGION });
    s3Cmds = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
    return true;
  } catch {
    return false;
  }
}

function s3ReadyForProofs() {
  return s3Configured() && !!process.env.AWS_S3_BUCKET && ensureS3();
}

const LOCAL_DIR = process.env.PAYMENT_PROOF_LOCAL_DIR
  || path.join(__dirname, '..', '..', 'uploads', 'payment-proofs');

function localPath(key) {
  const resolved = path.resolve(LOCAL_DIR, key);
  if (!resolved.startsWith(path.resolve(LOCAL_DIR) + path.sep)) return null;
  return resolved;
}

// production guard: financial evidence must not silently land on local disk
function assertStorageAvailable() {
  if (s3ReadyForProofs()) return 's3';
  if (process.env.NODE_ENV === 'production') {
    const e = new Error(
      'Payment proof storage requires S3 configuration in production '
      + '(PAYMENT_PROOF_STORAGE_BUCKET / AWS_S3_BUCKET + AWS credentials). '
      + 'Refusing to store financial evidence on local disk.'
    );
    e.status = 500;
    throw e;
  }
  return 'local';
}

// upload(buffer, { gymId, memberId, ext }) → { provider, key }
async function upload(buffer, { gymId, memberId, ext }) {
  const provider = assertStorageAvailable();
  const key = `${gymId}/${memberId}/${require('crypto').randomUUID()}.${ext}`;
  if (provider === 's3') {
    await s3Client.send(new s3Cmds.PutObjectCommand({
      Bucket: s3Bucket, Key: `payment-proofs/${key}`, Body: buffer,
      ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    }));
    return { provider: 's3', key: `payment-proofs/${key}` };
  }
  const dest = localPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { provider: 'local', key };
}

// getStream(record) → { stream } | null (null = file/object missing)
async function getStream(record) {
  if (!record || !record.screenshot_key) return null;
  if (record.screenshot_provider === 's3') {
    if (!ensureS3()) return null;
    try {
      const out = await s3Client.send(new s3Cmds.GetObjectCommand({
        Bucket: s3Bucket, Key: record.screenshot_key,
      }));
      return { stream: out.Body };
    } catch (e) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  }
  const p = localPath(record.screenshot_key);
  if (!p || !fs.existsSync(p)) return null;
  return { stream: fs.createReadStream(p) };
}

// remove(record) — idempotent; used when a pending proof is cancelled and
// its evidence is no longer needed
async function remove(record) {
  if (!record || !record.screenshot_key) return;
  if (record.screenshot_provider === 's3') {
    if (!ensureS3()) return;
    try {
      await s3Client.send(new s3Cmds.DeleteObjectCommand({
        Bucket: s3Bucket, Key: record.screenshot_key,
      }));
    } catch (e) {
      console.error(`[PaymentProofStorage] S3 delete failed (key=${record.screenshot_key}): ${e.name || 'Error'}`);
    }
    return;
  }
  try {
    const p = localPath(record.screenshot_key);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // already gone — idempotent by convention
  }
}

module.exports = { upload, getStream, remove, assertStorageAvailable, s3ReadyForProofs };
