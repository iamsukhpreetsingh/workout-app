// Gym portal API client core — session tokens, the api() wrapper and the
// auth surface. Domain-specific calls live in sibling modules (gyms.ts,
// members.ts, …) and are re-exported by ./index.ts, which is what the app
// imports as `../api`.
//
// The portal is just another client of the mobile backend: accounts
// authenticate through /auth (same users table, same JWTs) and every gym
// call carries the access token + the SELECTED gym id. The gym id is a
// selector only — the backend re-resolves role and membership from the
// token on every request.
//
// API base: relative paths by default (dev proxy / same-origin deploy).
// VITE_API_BASE_URL (repo root .env, baked at build time) points the bundle
// at a remote backend for static deployments.
const ACCESS_KEY = 'gymweb_access';
const REFRESH_KEY = 'gymweb_refresh';
const GYM_KEY = 'gymweb_gym';

export const API_BASE: string = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '')
  .replace(/\/+$/, '');

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
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
  const res = await fetch(`${API_BASE}/auth/login`, {
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
  const res = await fetch(`${API_BASE}/auth/signup`, {
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
  const res = await fetch(`${API_BASE}/auth/refresh`, {
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
    fetch(`${API_BASE}${path}`, {
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
    await fetch(`${API_BASE}/auth/logout`, {
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

// Raw access for special-case endpoints that must NOT go through api()
// (e.g. the gym logo blob download — it returns binary, not JSON).
export function getAccessToken(): string | null {
  return accessToken;
}
