// Gym profile surface: onboarding, settings, permissions, logo.
import { api, API_BASE, getAccessToken } from './client';

export interface OperatingHours {
  [day: string]: { open?: string; close?: string; closed?: boolean };
}

export interface Branding {
  primary_color?: string;
  secondary_color?: string;
}

export interface ProfileCompletion {
  percent: number;
  missing: string[];
}

export interface Gym {
  id: string;
  name: string;
  slug: string;
  status?: string;
  gym_status?: string;
  timezone: string;
  currency: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  logo_key?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  operating_hours?: OperatingHours | null;
  branding?: Branding | null;
  profile_completion?: ProfileCompletion;
}

export interface GymMembershipEntry {
  id: string;
  name: string;
  slug: string;
  gym_status: string;
  logo_key: string | null;
  gym_role: string;
  staff_status: string;
  staff_since: string;
}

export const getMyGyms = () => api<GymMembershipEntry[]>('/gym/mine');

export interface GymPermissions {
  gymId: string;
  gymName: string;
  gymRole: string;
  isMember: boolean;
  permissions: string[];
}

// The resolved gym context: THE route-guard data source. The portal may
// hide UI by role, but the backend re-checks every request anyway.
export const getGymPermissions = (gymId: string) => api<GymPermissions>(`/gym/${gymId}/permissions`);

export const createGym = (payload: Record<string, any>) =>
  api<{ gym: Gym; membershipRole: string | null; profile_completion: ProfileCompletion }>(
    '/gym', { method: 'POST', body: payload }
  );

export const getGym = (gymId: string) => api<Gym>(`/gym/${gymId}`);

export const updateGym = (gymId: string, patch: Record<string, any>) =>
  api<Gym>(`/gym/${gymId}`, { method: 'PATCH', body: patch });

export const deactivateGym = (gymId: string) =>
  api<Gym>(`/gym/${gymId}/deactivate`, { method: 'POST' });

export const reactivateGym = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/reactivate`, { method: 'POST' });

export const leaveGym = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/leave`, { method: 'POST' });

// Logo upload: file → base64 (the backend validates type via magic bytes
// and enforces the 2MB limit — the client limits are convenience only).
export async function uploadGymLogo(gymId: string, file: File): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
  await api(`/gym/${gymId}/logo`, {
    method: 'POST',
    body: { image_base64: base64, content_type: file.type || 'image/png' },
  });
}

export const removeGymLogo = (gymId: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/logo`, { method: 'DELETE' });

// The logo endpoint authorizes via the access token and returns BINARY, so
// it cannot go through the JSON api() wrapper — it fetches directly with
// the raw bearer token and yields a short-lived blob URL for <img src>.
export async function fetchGymLogoBlobUrl(gymId: string): Promise<string | null> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}/gym/${gymId}/logo`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Timezone choices for the profile forms. Older browsers without
// supportedValuesOf fall back to a small curated list.
export function timezoneOptions(): string[] {
  const supported = (Intl as any).supportedValuesOf?.('timeZone');
  if (Array.isArray(supported) && supported.length) return supported as string[];
  return [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
    'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
    'Australia/Sydney',
  ];
}
