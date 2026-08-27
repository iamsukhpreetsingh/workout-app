// Progress Photos — UI-side helpers: compression, date math, local photo
// access, authorized server-image fetching, and trainer-association state.
// Local SQLite stays the display source of truth; the sync engine keeps
// the server in step. Nothing here writes to the server except the
// read-only association check.
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';
import { api } from './api';
import { API_URL } from './config';

const PHOTOS_DIR = `${FileSystem.documentDirectory}progress_photos/`;

export const VISIBILITY = {
  PERSONAL: 'PERSONAL',
  TRAINER_SHARED: 'TRAINER_SHARED',
};

// Token accessor for authorized image fetches — wired by AuthContext at
// startup (avoids a circular import between api.js and this module).
let imageTokenGetter = async () => null;
export function setImageTokenGetter(fn) {
  imageTokenGetter = fn;
}
export function getTokenForImages() {
  return imageTokenGetter();
}

// ── compression (spec §18–19) ───────────────────────────────────────────
// Resizes to a 1600px max dimension (aspect preserved — resize takes only
// the max side), normalizes EXIF orientation, re-encodes JPEG at 0.7.
// A 12MB 4032×3024 camera shot lands around 1–2MB. If compression would
// make the file bigger (tiny sources), the original is returned.
export async function compressForUpload(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    const origKB = info.exists ? Math.round(info.size / 1024) : 0;
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    );
    const newInfo = await FileSystem.getInfoAsync(result.uri);
    const newKB = newInfo.exists ? Math.round(newInfo.size / 1024) : 0;
    if (origKB && newKB && newKB > origKB) return uri;
    return result.uri;
  } catch (e) {
    console.warn('[ProgressPhotos] compression failed, using original:', e.message);
    return uri;
  }
}

// ── date helpers (user's LOCAL calendar date is the truth, spec §25) ────
const pad = (n) => String(n).padStart(2, '0');
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`); // noon avoids DST edge cases
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function isFutureDate(dateStr) {
  return dateStr > todayLocal();
}
export function formatDateLong(dateStr) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}
export function formatDateShort(dateStr) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });
}

// ── photo access ────────────────────────────────────────────────────────
export async function getPhotoForDate(date) {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return null;
  return db.getFirstAsync('SELECT * FROM progress_photos WHERE date = ? AND user_id = ?', [date, userId]);
}
export async function getAllPhotos() {
  const db = await getDb();
  const userId = getCurrentUserId();
  if (!userId) return [];
  return db.getAllAsync('SELECT * FROM progress_photos WHERE user_id = ? ORDER BY date DESC', [userId]);
}

// Local display URI (file:// path) or null for server-only rows.
export function localDisplayUri(photo) {
  if (!photo) return null;
  if (photo.file_path) {
    return String(photo.file_path).startsWith('file:')
      ? photo.file_path
      : `${PHOTOS_DIR}${photo.file_path}`;
  }
  return null;
}

// THE display resolver: local file first; otherwise fetches the authorized
// server stream WITH the JWT, caches the bytes to a deterministic local
// file (offline-capable after first fetch), and returns the cache path.
// Returns null when nothing is displayable. Never throws.
export async function fetchDisplayUri(photo, getAccessToken) {
  const local = localDisplayUri(photo);
  if (local) return local;
  if (!photo?.image_path || !photo?.id) return null;
  const cachePath = `${PHOTOS_DIR}srv_${photo.id}.jpg`;
  try {
    const info = await FileSystem.getInfoAsync(cachePath);
    if (info.exists) return cachePath;
    await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
    const token = await getAccessToken();
    const res = await global.fetch(`${API_URL}${photo.image_path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const b64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const s = String(reader.result || '');
        const idx = s.indexOf('base64,');
        resolve(idx >= 0 ? s.slice(idx + 7) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (!b64) return null;
    await FileSystem.writeAsStringAsync(cachePath, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return cachePath;
  } catch {
    return null;
  }
}

// ── trainer association (drives the Share option's enabled state) ───────
export async function getTrainerAssociation() {
  try {
    const assoc = await api('/client/trainer');
    if (assoc && assoc.status === 'active') {
      return { hasTrainer: true, trainerName: assoc.trainer_name || 'your trainer' };
    }
    return { hasTrainer: false, trainerName: null };
  } catch {
    return { hasTrainer: false, trainerName: null };
  }
}