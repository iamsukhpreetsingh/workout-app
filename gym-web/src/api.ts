// Gym portal API client. The portal is just another client of the mobile
// backend: accounts authenticate through /auth (same users table, same JWTs)
// and every gym call carries the access token + the SELECTED gym id. The
// gym id is a selector only — the backend re-resolves role and membership
// from the token on every request.
const ACCESS_KEY = 'gymweb_access';
const REFRESH_KEY = 'gymweb_refresh';
const GYM_KEY = 'gymweb_gym';

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
}

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

export function getSelectedGymId(): string | null {
  return localStorage.getItem(GYM_KEY);
}

export function setSelectedGymId(id: string | null) {
  if (id) localStorage.setItem(GYM_KEY, id);
  else localStorage.removeItem(GYM_KEY);
}

export function clearSession() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  setSelectedGymId(null);
}

export async function login(email: string, password: string): Promise<UserProfile> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Login failed');
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return body.user as UserProfile;
}

export async function signup(name: string, email: string, password: string): Promise<UserProfile> {
  const res = await fetch('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, role: 'user' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Sign up failed');
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return body.user as UserProfile;
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  const res = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  accessToken = body.accessToken;
  refreshToken = body.refreshToken;
  localStorage.setItem(ACCESS_KEY, accessToken!);
  localStorage.setItem(REFRESH_KEY, refreshToken!);
  return true;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const call = () =>
    fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(getSelectedGymId() && path.includes('/gym/') && !path.startsWith('/gym/mine')
          ? { 'X-Gym-Id': getSelectedGymId()! }
          : {}),
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  let res = await call();
  if (res.status === 401 && (await tryRefresh())) res = await call();
  if (res.status === 401) {
    clearSession();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function logout() {
  if (refreshToken) {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  clearSession();
}

export function hasAccessToken(): boolean {
  return !!accessToken;
}

// ── gym surface ──────────────────────────────────────────────────────────

export const getMyGyms = () => api<GymMembershipEntry[]>('/gym/mine');

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

// The logo endpoint authorizes via the access token, so the <img> needs a
// short-lived blob URL rather than a plain src.
export async function fetchGymLogoBlobUrl(gymId: string): Promise<string | null> {
  const res = await fetch(`/gym/${gymId}/logo`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
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
