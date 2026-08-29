// Fetch wrapper for the backend. Attaches the current access token to every
// request; on a 401 it attempts exactly ONE silent refresh before giving up
// and forcing logout. Token get/set hooks are registered by AuthContext to
// avoid a circular import.
import { API_URL } from './config';

let tokenHooks = { getAccessToken: async () => null, onRefreshed: () => {}, onAuthFailed: () => {} };

export function registerTokenHooks(hooks) {
  tokenHooks = { ...tokenHooks, ...hooks };
}

// Base URL + current access token for the few places that must make a raw
// fetch outside this wrapper (e.g. streaming a protected image download).
// getAccessToken resolves via the hooks AuthContext registered, so it stays
// correct across refreshes.
export const API_BASE = API_URL;
export function getAccessToken() {
  return tokenHooks.getAccessToken();
}

async function rawRequest(path, { method = 'GET', body, headers } = {}) {
  const url = `${API_URL}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  } catch (e) {
    console.error('[API] Network error:', e.message, e);
    throw new ApiError(0, `Network request failed: ${e.message}`);
  }
}

export async function api(path, { method = 'GET', body, headers, skipAuth = false } = {}) {
  const token = skipAuth ? null : await tokenHooks.getAccessToken();
  let res = await rawRequest(path, {
    method,
    body,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
  });

  if (res.status === 401 && !skipAuth) {
    // one silent refresh attempt
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = await tokenHooks.getAccessToken();
      res = await rawRequest(path, {
        method,
        body,
        headers: { ...(newToken ? { Authorization: `Bearer ${newToken}` } : {}), ...(headers || {}) },
      });
    } else {
      tokenHooks.onAuthFailed();
      throw new ApiError(401, 'Session expired — please log in again');
    }
  }

  // const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  // if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    console.warn('[API] Error body:', JSON.stringify(data).slice(0, 300));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data;
}

let refreshPromise = null;

export async function tryRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const refresh = await tokenHooks.getRefreshToken();
      if (!refresh) return false;
      const res = await rawRequest('/auth/refresh', { method: 'POST', body: { refreshToken: refresh } });
      if (!res.ok) return false;
      const data = await res.json();
      await tokenHooks.onRefreshed(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
