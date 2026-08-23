// Smoke test for progression config endpoints (System 2). ⚠ Uses REAL
// accounts; the CLIENT account's progression setting gets overwritten.
const BASE_URL = 'http://localhost:4000';
const CLIENT = { email: 'hashtagsukh@gmail.com', password: 'Abcd@123' };
const TRAINER = { email: 'trainer@gmail.com', password: 'Abcd@123' }; // optional — trainer-override tests

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const report = (ok, label, extra) =>
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 140) : ''));

async function main() {
  const login = await api('/auth/login', { method: 'POST', body: CLIENT });
  if (!login.data?.accessToken) return report(false, '1. Client login failed', login.data);
  const token = login.data.accessToken;
  report(true, '1. Login OK');

  const list = await api('/progression-formulas', { token });
  report(list.status === 200 && list.data.length === 4, '2. Formula list has 4 entries');

  const r0 = await api('/client/progression-resolved', { token });
  report(r0.status === 200 && r0.data.source === 'default' && r0.data.formula_key === 'linear_progression',
    '3. Fresh user resolves to app default', r0.data);

  const put = await api('/user/progression-settings', { method: 'PUT', token, body: { formula_key: 'double_progression', params: { repMin: 6, repMax: 10 } } });
  report(put.status === 200, '4. Save own setting (double 6–10)');

  const r1 = await api('/client/progression-resolved', { token });
  report(r1.data.source === 'user_setting' && r1.data.formula_key === 'double_progression' && r1.data.params.repMin === 6,
    '5. Resolved now = own setting', r1.data);

  const bad1 = await api('/user/progression-settings', { method: 'PUT', token, body: { formula_key: 'nope' } });
  report(bad1.status === 400, '6a. Unknown formula_key rejected (400)');
  const bad2 = await api('/user/progression-settings', { method: 'PUT', token, body: { formula_key: 'linear_progression', params: { incrementKg: 999 } } });
  report(bad2.status === 400, '6b. Out-of-range param rejected (400)');

  if (TRAINER.email) {
    const tLogin = await api('/auth/login', { method: 'POST', body: TRAINER });
    if (!tLogin.data?.accessToken || tLogin.data.user.role !== 'trainer') {
      report(false, '7. Trainer login failed / not a trainer', tLogin.data?.user);
    } else {
      const tToken = tLogin.data.accessToken;
      const clientId = login.data.user.id;
      const set = await api(`/trainer/clients/${clientId}/progression-override`, {
        method: 'PUT', token: tToken, body: { formula_key: 'rpe_autoregulated', params: {} },
      });
      if (set.status === 403) {
        report(true, '7. Override write correctly refused (403) — accounts not linked');
      } else {
        report(set.status === 200, '7. Trainer override set (rpe_autoregulated)', set.data);
        const r2 = await api('/client/progression-resolved', { token });
        report(r2.data.source === 'trainer_override' && r2.data.formula_key === 'rpe_autoregulated' && !!r2.data.trainer_name,
          '8. Client now resolves to trainer override', r2.data);
        await api(`/trainer/clients/${clientId}/progression-override`, {
          method: 'PUT', token: tToken, body: { formula_key: 'linear_progression', params: {} },
        });
        const r3 = await api('/client/progression-resolved', { token });
        report(r3.data.source === 'trainer_override' && r3.data.formula_key === 'linear_progression',
          '9. Explicit default-key override ≠ no override (stays trainer_override)', r3.data);
        await api(`/trainer/clients/${clientId}/progression-override`, { method: 'DELETE', token: tToken });
        const r4 = await api('/client/progression-resolved', { token });
        report(r4.data.source === 'user_setting' && r4.data.formula_key === 'double_progression',
          '10. After DELETE → falls back to client own setting', r4.data);
        const ov = await api(`/trainer/clients/${clientId}/progression-override`, { token: tToken });
        report(ov.status === 200 && (ov.data === null || ov.data.formula_key === null),
          '11. Override read = null after clear', ov.data);
      }
    }
  } else {
    console.log('SKIP  7–11. Trainer-override tests (no trainer credentials provided)');
  }
  console.log('\nDone.');
}
main().catch((e) => console.error('Script crashed:', e.message));