// import * as FileSystem from 'expo-file-system';
// import { getDb } from './db';

// const PHOTOS_DIR = `${FileSystem.documentDirectory}progress_photos/`;

// async function ensurePhotosDir() {
//   const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
//   if (!dirInfo.exists) {
//     await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
//   }
// }

// export async function addProgressPhoto(date, uri, angle = null) {
//   await ensurePhotosDir();

//   const filename = `${date}_${Date.now()}_${angle || 'front'}.jpg`;
//   const destPath = `${PHOTOS_DIR}${filename}`;

//   await FileSystem.copyAsync({ from: uri, to: destPath });

//   const db = await getDb();
//   const result = await db.runAsync(
//     `INSERT INTO progress_photos (date, file_path, angle, created_at) VALUES (?, ?, ?, ?)`,
//     [date, filename, angle, new Date().toISOString()]
//   );

//   return result.lastInsertRowId;
// }

// export async function getProgressPhotos() {
//   const db = await getDb();
//   return db.getAllAsync(
//     `SELECT * FROM progress_photos ORDER BY date DESC, created_at DESC`
//   );
// }

// export async function getProgressPhotosByDate(date) {
//   const db = await getDb();
//   return db.getAllAsync(
//     `SELECT * FROM progress_photos WHERE date = ? ORDER BY created_at DESC`,
//     [date]
//   );
// }

// export async function getPhotoFilePath(filename) {
//   const path = `${PHOTOS_DIR}${filename}`;
//   const info = await FileSystem.getInfoAsync(path);
//   return info.exists ? path : null;
// }

// export async function deleteProgressPhoto(id) {
//   const db = await getDb();
//   const photo = await db.getFirstAsync('SELECT * FROM progress_photos WHERE id = ?', [id]);

//   if (photo) {
//     const path = `${PHOTOS_DIR}${photo.file_path}`;
//     const info = await FileSystem.getInfoAsync(path);
//     if (info.exists) {
//       await FileSystem.deleteAsync(path);
//     }
//     await db.runAsync('DELETE FROM progress_photos WHERE id = ?', [id]);
//   }
// }

// export async function getPhotosGroupedByDate() {
//   const photos = await getProgressPhotos();
//   const grouped = {};

//   for (const photo of photos) {
//     if (!grouped[photo.date]) {
//       grouped[photo.date] = [];
//     }
//     grouped[photo.date].push(photo);
//   }

//   return grouped;
// }







// Progress photos — local-first, USER-SCOPED, syncing to the first-class
// /progress-photos API. Locally captured photos store file_path and sync
// their bytes; server-fetched rows store image_path (the authorized stream
// endpoint) and display through fetchDisplayUri. One photo per user per
// date (replace semantics, LWW server-side).
import * as FileSystem from 'expo-file-system';
import { getDb } from './db';
import { getCurrentUserId } from '../db/userId';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const PHOTOS_DIR = `${FileSystem.documentDirectory}progress_photos/`;

async function ensurePhotosDir() {
  const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
  }
}

const toLocalDate = (d) => {
  const s = String(d || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(d).toISOString().slice(0, 10);
};

// Add OR replace the photo for a date for the CURRENT user.
export async function addProgressPhoto(date, uri, angle = null, visibility = 'PERSONAL') {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('Not signed in');
  await ensurePhotosDir();
  const photoDate = toLocalDate(date);

  const existing = await db.getFirstAsync(
    'SELECT id, file_path FROM progress_photos WHERE date = ? AND user_id = ?', [photoDate, userId]);

  const filename = `${userId.slice(0, 8)}_${photoDate}_${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: uri, to: `${PHOTOS_DIR}${filename}` });

  let rowId;
  if (existing) {
    await db.runAsync(
      `UPDATE progress_photos SET file_path = ?, angle = ?, visibility = ?, image_path = NULL, synced = 0, created_at = ? WHERE id = ?`,
      [filename, angle, visibility, new Date().toISOString(), existing.id]);
    rowId = existing.id;
    if (existing.file_path && existing.file_path !== filename) {
      const oldPath = `${PHOTOS_DIR}${existing.file_path}`;
      const info = await FileSystem.getInfoAsync(oldPath);
      if (info.exists) await FileSystem.deleteAsync(oldPath).catch(() => {});
    }
  } else {
    const result = await db.runAsync(
      `INSERT INTO progress_photos (date, file_path, angle, visibility, created_at, synced, user_id) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [photoDate, filename, angle, visibility, new Date().toISOString(), userId]);
    rowId = result.lastInsertRowId;
  }

  await enqueueUpsert('progress_photo', String(rowId));
  return rowId;
}

export async function getProgressPhotos() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync('SELECT * FROM progress_photos WHERE user_id = ? ORDER BY date DESC', [userId]);
}

export async function getProgressPhotoForDate(date) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  return db.getFirstAsync('SELECT * FROM progress_photos WHERE date = ? AND user_id = ?', [toLocalDate(date), userId]);
}

export async function getProgressPhotosByDate(date) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync('SELECT * FROM progress_photos WHERE date = ? AND user_id = ? ORDER BY created_at DESC', [toLocalDate(date), userId]);
}

export async function getPhotoFilePath(filename) {
  const path = `${PHOTOS_DIR}${filename}`;
  const info = await FileSystem.getInfoAsync(path);
  return info.exists ? path : null;
}

export async function setPhotoVisibility(id, visibility) {
  if (visibility !== 'PERSONAL' && visibility !== 'TRAINER_SHARED') {
    throw new Error("visibility must be 'PERSONAL' or 'TRAINER_SHARED'");
  }
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  await db.runAsync('UPDATE progress_photos SET visibility = ?, synced = 0 WHERE id = ? AND user_id = ?', [visibility, id, userId]);
  await enqueueUpsert('progress_photo', String(id));
  return visibility;
}

export async function deleteProgressPhoto(id) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return;
  const photo = await db.getFirstAsync('SELECT * FROM progress_photos WHERE id = ? AND user_id = ?', [id, userId]);
  if (!photo) return;
  await enqueueDelete('progress_photo', String(id), !!photo.server_id,
    photo.server_id ? { server_id: photo.server_id } : null);
  if (photo.file_path) {
    const path = `${PHOTOS_DIR}${photo.file_path}`;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) await FileSystem.deleteAsync(path);
  }
  await db.runAsync('DELETE FROM progress_photos WHERE id = ?', [id]);
}

export function photoDisplayPath(photo) {
  if (!photo) return null;
  if (photo.file_path) {
    return String(photo.file_path).startsWith('file:')
      ? photo.file_path
      : `${PHOTOS_DIR}${photo.file_path}`;
  }
  return photo.image_path || null;
}

// One-time claim: pre-v37 rows have NULL user_id; the first account to log
// in after the upgrade takes them (they were invisible to everyone until
// claimed — no misattribution window). Called from backfill.js.
export async function adoptLegacyPhotos(userId) {
  if (!userId) return;
  const db = await getDb();
  await db.runAsync(
    'UPDATE progress_photos SET user_id = ? WHERE user_id IS NULL', [userId]);
}