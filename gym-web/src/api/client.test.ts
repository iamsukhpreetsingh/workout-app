// Session layer tests: token storage, gym selection, api() error semantics
// and the one-shot 401 refresh. Uses the jsdom localStorage + a mocked
// global fetch — no backend needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  login, signup, logout, api, clearSession, hasAccessToken,
  getSelectedGymId, setSelectedGymId, getAccessToken, API_BASE,
} from './client';

// Note: the "final 401 → window.location.reload()" path is deliberately NOT
// exercised here — jsdom cannot stub location. Its observable side effects
// (clearSession + thrown 'Session expired') are covered by clearSession tests.

function mockFetchOnce(status: number, body: any) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  localStorage.clear();
  clearSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session storage', () => {
  it('starts signed out with an empty API base (relative paths)', () => {
    expect(hasAccessToken()).toBe(false);
    expect(API_BASE).toBe('');
    expect(getAccessToken()).toBeNull();
  });

  it('round-trips the selected gym id', () => {
    expect(getSelectedGymId()).toBeNull();
    setSelectedGymId('gym-123');
    expect(getSelectedGymId()).toBe('gym-123');
    setSelectedGymId(null);
    expect(getSelectedGymId()).toBeNull();
  });

  it('clearSession wipes tokens and the gym selection', () => {
    setSelectedGymId('gym-123');
    localStorage.setItem('gymweb_access', 'a');
    localStorage.setItem('gymweb_refresh', 'r');
    clearSession();
    expect(getSelectedGymId()).toBeNull();
    expect(localStorage.getItem('gymweb_access')).toBeNull();
    expect(localStorage.getItem('gymweb_refresh')).toBeNull();
  });
});

describe('auth calls', () => {
  it('login stores both tokens and returns the user', async () => {
    const fetchMock = mockFetchOnce(200, {
      accessToken: 'acc-1', refreshToken: 'ref-1', user: { id: 'u1', name: 'A', email: 'a@x.com', role: 'user' },
    });
    const user = await login('a@x.com', 'pw');
    expect(user.id).toBe('u1');
    expect(hasAccessToken()).toBe(true);
    expect(localStorage.getItem('gymweb_access')).toBe('acc-1');
    expect(localStorage.getItem('gymweb_refresh')).toBe('ref-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/auth/login');
    expect((init as any).method).toBe('POST');
  });

  it('login surfaces the backend error message on failure', async () => {
    mockFetchOnce(401, { error: 'Invalid email or password' });
    await expect(login('a@x.com', 'bad')).rejects.toThrow('Invalid email or password');
    expect(hasAccessToken()).toBe(false);
  });

  it('signup stores tokens the same way', async () => {
    mockFetchOnce(200, {
      accessToken: 'acc-2', refreshToken: 'ref-2', user: { id: 'u2', name: 'B', email: 'b@x.com', role: 'user' },
    });
    await signup('B', 'b@x.com', 'pw');
    expect(getAccessToken()).toBe('acc-2');
  });

  it('logout clears the session even if the server call fails', async () => {
    mockFetchOnce(200, {
      accessToken: 'acc-3', refreshToken: 'ref-3', user: { id: 'u3', name: 'C', email: 'c@x.com', role: 'user' },
    });
    await signup('C', 'c@x.com', 'pw');
    expect(hasAccessToken()).toBe(true);
    // make the logout network call itself blow up
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await logout();
    expect(hasAccessToken()).toBe(false);
    expect(getAccessToken()).toBeNull();
  });
});

describe('api() wrapper', () => {
  it('passes the bearer token and X-Gym-Id selector for gym paths', async () => {
    mockFetchOnce(200, { accessToken: 'tok-1', refreshToken: 'r1', user: { id: 'u1', name: 'A', email: 'a@x.com', role: 'user' } });
    await login('a@x.com', 'pw');
    setSelectedGymId('gym-9');
    const fetchMock = mockFetchOnce(200, []);
    await api('/gym/gym-9/members');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/gym/gym-9/members');
    expect((init as any).headers.Authorization).toBe('Bearer tok-1');
    expect((init as any).headers['X-Gym-Id']).toBe('gym-9');
  });

  it('does NOT send X-Gym-Id for /gym/mine (selector must not leak)', async () => {
    mockFetchOnce(200, { accessToken: 'tok-1', refreshToken: 'r1', user: { id: 'u1', name: 'A', email: 'a@x.com', role: 'user' } });
    await login('a@x.com', 'pw');
    setSelectedGymId('gym-9');
    const fetchMock = mockFetchOnce(200, []);
    await api('/gym/mine');
    expect((fetchMock.mock.calls[0][1] as any).headers['X-Gym-Id']).toBeUndefined();
  });

  it('throws the backend error message for non-2xx responses', async () => {
    mockFetchOnce(200, { accessToken: 'tok-1', refreshToken: 'r1', user: { id: 'u1', name: 'A', email: 'a@x.com', role: 'user' } });
    await login('a@x.com', 'pw');
    mockFetchOnce(403, { error: 'Not allowed' });
    await expect(api('/gym/x/things')).rejects.toThrow('Not allowed');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    mockFetchOnce(200, { accessToken: 'tok-1', refreshToken: 'r1', user: { id: 'u1', name: 'A', email: 'a@x.com', role: 'user' } });
    await login('a@x.com', 'pw');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => { throw new Error('not json'); },
    }));
    await expect(api('/gym/x/things')).rejects.toThrow('Request failed (500)');
  });
});
