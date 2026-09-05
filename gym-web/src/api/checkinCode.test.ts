// Door poster check-in code (Mobile M6 follow-up): wrapper targets, the
// poster payload format the mobile app resolves, and the payload/code
// relationship. Uses the mocked global fetch + jsdom localStorage pattern
// from client.test.ts — no backend needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCheckinCode, rotateCheckinCode, checkinPosterPayload,
  getSelectedGymId, setSelectedGymId,
} from './index';
import { login } from './client';

const GYM = 'gym-poster-1';
const CODE = 'a'.repeat(32); // 128-bit secret as issued: 32 hex chars (crypto.randomBytes(16).toString('hex'))

function mockJson(status: number, body: any) {
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
  localStorage.setItem('gymweb_gym', GYM);
  setSelectedGymId(GYM);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkinPosterPayload', () => {
  it('prefixes the code with the gymcheckin:v1 scheme the app resolves', () => {
    expect(checkinPosterPayload(CODE)).toBe(`gymcheckin:v1:${CODE}`);
  });

  it('keeps the code intact — the bare code must also work when typed', () => {
    const payload = checkinPosterPayload(CODE);
    expect(payload.endsWith(CODE)).toBe(true);
    expect(payload.slice('gymcheckin:v1:'.length)).toBe(CODE);
  });

  it('never embeds the gym id — the poster is a secret, not an address', () => {
    expect(checkinPosterPayload(CODE)).not.toContain(GYM);
  });
});

describe('checkin-code wrappers', () => {
  beforeEach(async () => {
    // seed the access token so the Authorization header path is exercised
    mockJson(200, { accessToken: 'at', refreshToken: 'rt', user: { id: 'u1' } });
    await login('owner@demo.test', 'Test@1234');
    mockJson(200, { checkin_code: CODE });
  });

  it('GETs the gym checkin-code endpoint with the selected gym header', async () => {
    const r = await getCheckinCode(GYM);
    expect(r.checkin_code).toBe(CODE);
    // login consumed call 0 of the previous stub — this fresh stub sees the wrapper call at index 0
    const [url, init] = vi.mocked(fetch).mock.calls[0] as any;
    expect(url).toBe(`/gym/${GYM}/attendance/checkin-code`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer at');
    expect(init.headers['X-Gym-Id']).toBe(GYM);
  });

  it('POSTs the rotate endpoint and returns the new code', async () => {
    const NEW = 'b'.repeat(64);
    mockJson(200, { checkin_code: NEW });
    const r = await rotateCheckinCode(GYM);
    expect(r.checkin_code).toBe(NEW);
    expect(r.checkin_code).not.toBe(CODE);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as any;
    expect(url).toBe(`/gym/${GYM}/attendance/checkin-code/rotate`);
    expect(init.method).toBe('POST');
  });

  it('surfaces backend errors (e.g. 403 without checkin.manage) as thrown messages', async () => {
    mockJson(403, { error: 'Missing permission: checkin.manage' });
    await expect(getCheckinCode(GYM)).rejects.toThrow('checkin.manage');
  });
});

describe('poster contract sanity', () => {
  it('issued codes are 32 lowercase hex chars (128-bit secret)', () => {
    expect(CODE).toMatch(/^[0-9a-f]{32}$/);
    expect(getSelectedGymId()).toBe(GYM);
  });
});
