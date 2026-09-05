// Gym Documents — mobile-side file access (Mobile M3).
//
// Phase 18 streamed document bytes only to the web portal; the app showed
// metadata alone. Now the app can VIEW its own documents too:
//
//   • downloadGymDocument() fetches the member's own file from
//     GET /gym/my/documents/:id/file WITH the JWT (the endpoint requires
//     the Authorization header, so a plain Linking/WebView URL is not an
//     option), caches it under FileSystem.cacheDirectory and returns a
//     local file:// URI.
//
//   • Caching: a document's bytes are immutable — superseding a document
//     creates a NEW row/id (the old one is REPLACED and stops streaming) —
//     so the cache key is just the id. The cache lives in the OS cache dir
//     (purgeable, not backed up, not synced) which is the right home for
//     re-downloadable private files.
//
//   • Auth follows the app-wide contract: on a 401 exactly ONE silent
//     refresh is attempted (api.js's tryRefresh) and the download retries
//     once. Network failures and 5xx NEVER trigger logout — the error is
//     surfaced and the user can retry.
//
//   • Every UNCACHED open is a real download and lands in the gym's
//     document access log server-side (same as the web portal); cached
//     re-opens don't re-hit the network.
//
// Viewing strategy per content type (uploads are locked to PDF/PNG/JPEG):
//   • PDF   → iOS: in-app WKWebView renders PDFs natively.
//             Android: WebView has no PDF engine, so the file is opened
//             with the system viewer (ACTION_VIEW + content:// URI +
//             FLAG_GRANT_READ_URI_PERMISSION) — the standard Android flow.
//   • Image → shown in-app with <Image> on both platforms.
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import { API_BASE, getAccessToken, tryRefresh, ApiError } from './api';

const DOCS_DIR = `${FileSystem.cacheDirectory}gym-docs/`;

// ── content-type mapping ─────────────────────────────────────────────────
// Returns 'pdf' | 'image' | null. Backend magic-byte-sniffs every upload
// (application/pdf, image/png, image/jpeg only), so a null here means the
// row has no viewable file (shouldn't happen for live rows).
export function documentKind(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  return null;
}

export function documentExtension(contentType) {
  const kind = documentKind(contentType);
  if (kind === 'pdf') return '.pdf';
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpg') || ct.includes('jpeg')) return '.jpg';
  return kind === 'image' ? '.img' : '.bin';
}

// "1.2 MB" / "840 KB" — file_size is server-reported byte count.
export function humanFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── download + cache ─────────────────────────────────────────────────────
function cachePathFor(doc) {
  return `${DOCS_DIR}${doc.id}${documentExtension(doc.content_type)}`;
}

// blob → base64 → file (same pattern as progressPhotos.fetchDisplayUri).
async function writeResponseToFile(res, cachePath) {
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
  if (!b64) throw new Error('Could not read the document file.');
  await FileSystem.makeDirectoryAsync(DOCS_DIR, { intermediates: true });
  await FileSystem.writeAsStringAsync(cachePath, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

// Resolves { kind, uri, cached } or throws with a user-safe message.
// The token comes from api.js's hook registry (registered by AuthContext),
// so it stays correct across silent refreshes.
export async function downloadGymDocument(doc, { forceDownload = false } = {}) {
  if (!doc || !doc.id) throw new Error('Document is unavailable.');
  const kind = documentKind(doc.content_type);
  if (!kind) throw new Error('This document has no viewable file attached.');

  const cachePath = cachePathFor(doc);
  if (!forceDownload) {
    try {
      const info = await FileSystem.getInfoAsync(cachePath);
      if (info.exists) return { kind, uri: cachePath, cached: true };
    } catch {
      // stat failure → fall through and download fresh
    }
  }

  const path = `/gym/my/documents/${doc.id}/file`;
  const fetchOnce = async () => {
    const token = await getAccessToken();
    return global.fetch(`${API_BASE}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };

  let res;
  try {
    res = await fetchOnce();
    if (res.status === 401) {
      // One silent refresh, then retry once — mirrors api().tryRefresh's
      // three-value contract: true → retry, false → session over, null →
      // offline/5xx (never a logout).
      const refreshed = await tryRefresh();
      if (refreshed === true) {
        res = await fetchOnce();
      } else if (refreshed === false) {
        throw new ApiError(401, 'Session expired — please log in again');
      } else {
        throw new ApiError(0, 'You appear to be offline. Check your connection and retry.');
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'You appear to be offline. Check your connection and retry.');
  }

  if (!res.ok) {
    // The file endpoint answers JSON errors for every non-stream case
    // (403 inactive membership, 404 not-yours, 409 replaced/revoked,
    // 410 bytes gone) — surface the server's exact reason.
    let message = `Could not load the document (${res.status}).`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }

  await writeResponseToFile(res, cachePath);
  return { kind, uri: cachePath, cached: false };
}

// ── Android: hand the PDF to the system viewer ───────────────────────────
// Android's WebView cannot render PDFs, so the platform-correct move is
// ACTION_VIEW on a content:// URI (FileProvider) with the read-permission
// flag. Throws when no PDF viewer is installed — the caller shows a
// helpful fallback. On iOS this helper is never called.
export async function openPdfWithSystemViewer(fileUri, { mimeType = 'application/pdf' } = {}) {
  if (Platform.OS !== 'android') return false;
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  await IntentLauncher.startActivityAsync(IntentLauncher.ACTION_VIEW, {
    data: contentUri,
    type: mimeType,
    flags: IntentLauncher.FLAG_GRANT_READ_URI_PERMISSION,
  });
  return true;
}
