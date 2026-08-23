// Admin API client: attaches the admin access token, performs one silent
// refresh on 401, and holds the logged-in admin's profile.
const BASE = '/admin';

let accessToken: string | null = localStorage.getItem('admin_access');
let refreshToken: string | null = localStorage.getItem('admin_refresh');

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}

let profile: AdminProfile | null = null;

export function getProfile() {
  return profile;
}

export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('admin_access', access);
  localStorage.setItem('admin_refresh', refresh);
}

export function clearSession() {
  accessToken = null;
  refreshToken = null;
  profile = null;
  localStorage.removeItem('admin_access');
  localStorage.removeItem('admin_refresh');
}

export async function login(email: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Login failed');
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  profile = data.admin;
  return data.admin as AdminProfile;
}

async function tryRefresh() {
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  profile = data.admin;
  return true;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const call = () =>
    fetch(`${BASE}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  let res = await call();
  if (res.status === 401 && (await tryRefresh())) {
    res = await call();
  }
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
    await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  clearSession();
}

// restore profile on page reload
export async function restoreProfile() {
  if (!accessToken) return null;
  try {
    profile = await api<AdminProfile>('/me');
    return profile;
  } catch {
    return null;
  }
}
