// Smoke test for the Progress Photos backend. ⚠ Writes REAL photos for the
// client account and test 13 (optional) UNLINKS the trainer relationship.
const BASE_URL = 'http://localhost:4000';
const CLIENT = { email: 'hashtagsukh@gmail.com', password: 'Abcd@123' };
const TRAINER = { email: 'trainer@gmail.com', password: 'Abcd@123' }; // optional — tests 9–14

async function api(path, { method = 'GET', body, token, raw } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const report = (ok, label, extra) =>
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 130) : ''));

const IMG = 'SGVsbG8gUGhvdG8='; // any base64 passes the 8MB pipeline check
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const login = await api('/auth/login', { method: 'POST', body: CLIENT });
  if (!login.data?.accessToken) return report(false, '1. Client login failed', login.data);
  const token = login.data.accessToken;
  const clientId = login.data.user.id;
  report(true, '1. Login OK');

  const created = await api('/progress-photos', {
    method: 'POST', token,
    body: { photo_date: day(0), visibility: 'PERSONAL', image_base64: IMG },
  });
  report(created.status === 201 && created.data.visibility === 'PERSONAL', '2. Create today (PERSONAL)', created.data);

  const future = await api('/progress-photos', {
    method: 'POST', token, body: { photo_date: day(2), image_base64: IMG },
  });
  report(future.status === 400 && /future/i.test(future.data?.error || ''), '3. Future date rejected (400)', future.data);

  const list = await api('/progress-photos', { token });
  const mine = list.data?.find((p) => p.id === created.data?.id) || list.data?.[0];
  report(!!mine && !!mine.image_path, '4. List contains today + image_path', list.data?.length);

  const imgRes = await api(`${mine.image_path}`, { token, raw: true });
  const imgLen = imgRes ? (await imgRes.arrayBuffer()).byteLength : 0;
  report(imgRes?.status === 200 && imgLen > 0 && String(imgRes.headers.get('content-type')).startsWith('image/'),
    '5. Owner streams image (200, image/*)');

  const noauth = await api(`${mine.image_path}`, { raw: true });
  report(noauth?.status === 401, '6. Unauthenticated image → 401');

  const shared = await api(`/progress-photos/${mine.id}`, {
    method: 'PATCH', token, body: { visibility: 'TRAINER_SHARED' },
  });
  report(shared.status === 200 && shared.data.visibility === 'TRAINER_SHARED', '7. Visibility → TRAINER_SHARED');

  const replaced = await api('/progress-photos', {
    method: 'POST', token, body: { photo_date: day(0), visibility: 'TRAINER_SHARED', image_base64: IMG },
  });
  report(replaced.status === 201, '8. Re-upload same date = replace (no duplicate)');
  const list2 = await api('/progress-photos', { token });
  report(list2.data.filter((p) => p.photo_date === day(0)).length === 1, '8b. Still exactly one photo for today');

  if (TRAINER.email) {
    const tLogin = await api('/auth/login', { method: 'POST', body: TRAINER });
    if (!tLogin.data?.accessToken || tLogin.data.user.role !== 'trainer') {
      report(false, '9. Trainer login failed / not trainer', tLogin.data?.user);
    } else {
      const tToken = tLogin.data.accessToken;
      const tList = await api(`/trainer/clients/${clientId}/progress-photos`, { token: tToken });
      if (tList.status === 403) {
        report(true, '9. Trainer list refused (403) — accounts not linked; link them to run 9-14');
      } else {
        report(tList.status === 200 && tList.data.some((p) => p.photo_date === day(0)), '9. Trainer sees the SHARED photo', tList.data?.length);
        const tImg = await api(`${mine.image_path}`, { token: tToken, raw: true });
        report(tImg?.status === 200, '10. Trainer streams the shared image');

        await api(`/progress-photos/${mine.id}`, { method: 'PATCH', token, body: { visibility: 'PERSONAL' } });
        const tList2 = await api(`/trainer/clients/${clientId}/progress-photos`, { token: tToken });
        report(tList2.status === 200 && tList2.data.length === 0, '11. Flip to PERSONAL → trainer list empty');
        const tImg2 = await api(`${mine.image_path}`, { token: tToken, raw: true });
        report(tImg2?.status === 404, '12. Trainer direct image access → 404 (never 403 — no existence leak)');

        await api(`/progress-photos/${mine.id}`, { method: 'PATCH', token, body: { visibility: 'TRAINER_SHARED' } });
        // ⚠ DESTRUCTIVE: unlinks the trainer relationship (re-link with an
        // invite code afterward)
        const unl = await api('/client/trainer/unlink', { method: 'POST', token });
        report(unl.status === 200, '13a. Client unlinks trainer');
        const tList3 = await api(`/trainer/clients/${clientId}/progress-photos`, { token: tToken });
        report(tList3.status === 403, '13b. +1 RULE: after unlink, trainer list → 403');
        const tImg3 = await api(`${mine.image_path}`, { token: tToken, raw: true });
        report(tImg3?.status === 404, '13c. +1 RULE: trainer image access → 404');
        const mineStill = await api(`${mine.image_path}`, { token, raw: true });
        report(mineStill?.status === 200, '13d. Owner still sees own photo (never deleted)');
      }
    }
  } else {
    console.log('SKIP  9–14. Trainer tests (no trainer credentials provided)');
  }

  // cleanup: delete today's photo
  await api(`/progress-photos/${mine.id}`, { method: 'DELETE', token });
  const list3 = await api('/progress-photos', { token });
  report(!list3.data.some((p) => p.photo_date === day(0)), '14. Delete removes the photo');
  console.log('\nDone.');
}
main().catch((e) => console.error('Script crashed:', e.message));   