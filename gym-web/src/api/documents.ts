// Gym member documents & digital waivers (Phase 18). Documents belong to
// the GymMember row — the desk files paperwork for members who have no
// app account, and the very same rows surface in the member's app once
// they connect. Bytes never travel as predictable public URLs: downloads
// stream through the authorized /file endpoints with the session token,
// and every read is access-logged server-side.
import { api, API_BASE, getAccessToken, getSelectedGymId } from './client';

export const DOCUMENT_CATEGORIES = [
  { value: 'WAIVER', label: 'Liability Waiver' },
  { value: 'MEMBERSHIP_AGREEMENT', label: 'Membership Agreement' },
  { value: 'ID_VERIFICATION', label: 'ID Verification' },
  { value: 'MEDICAL_CLEARANCE', label: 'Medical Clearance' },
  { value: 'OTHER', label: 'Other Document' },
] as const;

export const MAX_DOCUMENT_MB = 8;
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

export interface MemberDocument {
  id: string;
  gym_id: string;
  member_id: string;
  category: string;
  category_label: string;
  title: string | null;
  status: 'PENDING' | 'AUTHORIZED' | 'REPLACED' | 'REVOKED';
  effective_status: string; // PENDING | AUTHORIZED | EXPIRED | REPLACED | REVOKED
  expired: boolean;
  is_live: boolean;
  original_filename: string;
  content_type: string;
  file_size: number;
  file_sha256: string;
  expires_at: string | null;
  authorized_at: string | null;
  authorized_signature?: string | null;
  uploaded_via: 'DESK' | 'APP';
  uploaded_by: string | null;
  replaced_by: string | null;
  created_at: string;
  download_path: string;
  download_history?: Array<{
    actor_kind: 'STAFF' | 'MEMBER';
    actor_label: string | null;
    actor_user_id: string | null;
    ip: string | null;
    created_at: string;
  }>;
}

export interface MemberDocumentsResult {
  member: {
    id: string;
    member_code: string;
    first_name: string;
    last_name: string | null;
    status: string;
    paperwork_allowed: boolean;
  };
  documents: MemberDocument[];
}

export interface DocumentUploadPayload {
  category: string;
  title?: string | null;
  expires_at?: string | null;
  filename: string;
  content_type: string;
  content_base64: string;
}

// ── staff surface (documents.manage) ───────────────────────────────────────

export const listMemberDocuments = (gymId: string, memberId: string) =>
  api<MemberDocumentsResult>(`/gym/${gymId}/members/${memberId}/documents`);

export const getMemberDocument = (gymId: string, memberId: string, documentId: string) =>
  api<MemberDocument>(`/gym/${gymId}/members/${memberId}/documents/${documentId}`);

export const uploadMemberDocument = (
  gymId: string, memberId: string, payload: DocumentUploadPayload,
) =>
  api<MemberDocument>(`/gym/${gymId}/members/${memberId}/documents`, {
    method: 'POST', body: payload,
  });

export const authorizeMemberDocument = (
  gymId: string, memberId: string, documentId: string, signature_name: string,
) =>
  api<MemberDocument>(`/gym/${gymId}/members/${memberId}/documents/${documentId}/authorize`, {
    method: 'POST', body: { signature_name },
  });

export const revokeMemberDocument = (
  gymId: string, memberId: string, documentId: string, reason?: string,
) =>
  api<MemberDocument>(`/gym/${gymId}/members/${memberId}/documents/${documentId}/revoke`, {
    method: 'POST', body: { reason: reason || null },
  });

// Bytes stream through the authorized endpoint with the session token —
// the browser saves them as a file. (api() is JSON-only, so this does its
// own fetch with the same headers.)
export async function downloadMemberDocument(document: MemberDocument): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const gymId = getSelectedGymId();
  if (gymId && document.download_path.includes('/gym/')) headers['X-Gym-Id'] = gymId;
  const res = await fetch(`${API_BASE}${document.download_path}`, { headers });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = document.original_filename || 'document';
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Client-side pre-validation — the server re-checks everything (size cap,
// MIME whitelist, magic bytes, filename sanitization) and rejects first.
export function validateDocumentFile(file: File): string | null {
  if (!ALLOWED_MIME.includes(file.type)) {
    return 'Only PDF, PNG and JPEG files are accepted';
  }
  if (file.size > MAX_DOCUMENT_MB * 1024 * 1024) {
    return `File exceeds the ${MAX_DOCUMENT_MB}MB limit`;
  }
  if (file.size === 0) return 'File is empty';
  return null;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}
