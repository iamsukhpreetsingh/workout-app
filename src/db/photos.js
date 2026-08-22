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




import * as FileSystem from 'expo-file-system';
import { getDb } from './db';
import { enqueueUpsert, enqueueDelete } from '../lib/syncEngine';

const PHOTOS_DIR = `${FileSystem.documentDirectory}progress_photos/`;

async function ensurePhotosDir() {
  const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
  }
}

export async function addProgressPhoto(date, uri, angle = null) {
  await ensurePhotosDir();

  const filename = `${date}_${Date.now()}_${angle || 'front'}.jpg`;
  const destPath = `${PHOTOS_DIR}${filename}`;

  await FileSystem.copyAsync({ from: uri, to: destPath });

  const db = await getDb();
  const result = await db.runAsync(
    `INSERT INTO progress_photos (date, file_path, angle, created_at) VALUES (?, ?, ?, ?)`,
    [date, filename, angle, new Date().toISOString()]
  );

  // photos are user data — queue the file backup (the engine reads the local
  // file at upload time; until then the photo lives safely on-device)
  await enqueueUpsert('progress_photo', String(result.lastInsertRowId));

  return result.lastInsertRowId;
}

export async function getProgressPhotos() {
  const db = await getDb();
  return db.getAllAsync(`SELECT * FROM progress_photos ORDER BY date DESC, created_at DESC`);
}

export async function getProgressPhotosByDate(date) {
  const db = await getDb();
  return db.getAllAsync(`SELECT * FROM progress_photos WHERE date = ? ORDER BY created_at DESC`, [date]);
}

export async function getPhotoFilePath(filename) {
  const path = `${PHOTOS_DIR}${filename}`;
  const info = await FileSystem.getInfoAsync(path);
  return info.exists ? path : null;
}

export async function deleteProgressPhoto(id) {
  const db = await getDb();
  const photo = await db.getFirstAsync('SELECT * FROM progress_photos WHERE id = ?', [id]);

  if (photo) {
    // queue the server delete BEFORE the row disappears (only if it was
    // ever backed up — never-synced photos delete cleanly with no call)
    await enqueueDelete('progress_photo', String(id), !!photo.server_id);
    const path = `${PHOTOS_DIR}${photo.file_path}`;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      await FileSystem.deleteAsync(path);
    }
    await db.runAsync('DELETE FROM progress_photos WHERE id = ?', [id]);
  }
}

export async function getPhotosGroupedByDate() {
  const photos = await getProgressPhotos();
  const grouped = {};
  for (const photo of photos) {
    if (!grouped[photo.date]) grouped[photo.date] = [];
    grouped[photo.date].push(photo);
  }
  return grouped;
}