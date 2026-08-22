// Storage abstraction for user file backups (System 4). EVERY disk-path
// assumption in the entire backend lives in this one file — swapping to
// S3/Supabase Storage later means changing only this module. No route or
// data module may touch the file system directly.
const fs = require('fs');
const path = require('path');

// Files land under backend/uploads/progress-photos/<user_id>/<filename> and
// are served by the existing static route (app.use('/uploads', ...)) in
// server.js — no new route registration needed.
const ROOT = path.join(__dirname, '..', '..', 'uploads', 'progress-photos');

async function upload(fileBuffer, key) {
  const dest = path.join(ROOT, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fileBuffer);
  return key;
}

async function remove(key) {
  try {
    fs.unlinkSync(path.join(ROOT, key));
  } catch {
    // already gone — idempotent by convention
  }
}

function getUrl(req, key) {
  return `${req.protocol}://${req.get('host')}/uploads/progress-photos/${key}`;
}

module.exports = { upload, remove, getUrl };