// Quick smoke test for the intake-profile backend.
// Run from the backend folder:  node test-intake.js
// Safe to re-run. ⚠ Uses REAL accounts — prefer a TEST account,
// because it overwrites that account's profile.

const BASE_URL = 'http://localhost:4000'; // change to http://13.126.205.202:4000 to test the live server

const CLIENT = {
  email: 'hashtagsukh@gmail.com',
  password: 'Abcd@123',
};

const TRAINER = {
  email: '', // optional — leave empty to skip test 8
  password: '',
};

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function report(ok, label, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

async function main() {
  console.log('Testing intake profiles against ' + BASE_URL + '\n');

  const health = await api('/health');
  report(health.status === 200, '1. Server is running');
  if (health.status !== 200) {
    console.log('   → Start the backend first, then re-run.');
    return;
  }

  const login = await api('/auth/login', { method: 'POST', body: CLIENT });
  if (login.status !== 200 || !login.data.accessToken) {
    report(false, '2. Client login failed — check the email/password at the top of this file', login.data);
    return;
  }
  const token = login.data.accessToken;
  const clientUserId = login.data.user.id;
  report(true, '2. Client login OK — testing as: ' + login.data.user.name);

  const before = await api('/client/intake-profile', { token });
  if (before.status === 500) {
    report(false, '3. Server error reading profile — did migration 023 run? (node scripts/migrate.js)', before.data);
    return;
  }
  report(before.status === 200, '3. Read own profile (200). Current value:', before.data);

  const put = await api('/client/intake-profile', {
    method: 'PUT',
    token,
    body: {
      allergens: ['nuts', 'dairy'],
      goals: ['weight loss'],
      injuries: 'mild lower back pain',
      medical_conditions: 'type 2 diabetes',
    },
  });
  report(put.status === 200 && !!put.data.completed_at, '4. Profile saved, completed_at stamped', put.data);

  const after = await api('/client/intake-profile', { token });
  const roundTrip = after.data
    && Array.isArray(after.data.allergens)
    && after.data.allergens.includes('nuts')
    && after.data.allergens.includes('dairy')
    && !!after.data.completed_at;
  report(!!roundTrip, '5. Saved data reads back correctly (allergens: nuts, dairy)', after.data && after.data.allergens);

  const bad = await api('/client/intake-profile', { method: 'PUT', token, body: { allergens: 'nuts' } });
  report(bad.status === 400, '6. Bad input correctly rejected with 400');

  const noauth = await api('/client/intake-profile');
  report(noauth.status === 401, '7. Request without login correctly rejected (401)');

  if (TRAINER.email) {
    const tLogin = await api('/auth/login', { method: 'POST', body: TRAINER });
    if (tLogin.status !== 200 || !tLogin.data.accessToken) {
      report(false, '8. Trainer login failed — check credentials', tLogin.data);
    } else if (tLogin.data.user.role !== 'trainer') {
      report(false, '8. That account is not a trainer (role: ' + tLogin.data.user.role + ')');
    } else {
      const tRead = await api('/trainer/clients/' + clientUserId + '/intake-profile', { token: tLogin.data.accessToken });
      if (tRead.status === 200) {
        report(!!(tRead.data && tRead.data.allergens), '8. Trainer read OK — sees the profile just saved', tRead.data && tRead.data.allergens);
      } else if (tRead.status === 403) {
        report(true, '8. Trainer read correctly REFUSED (403) — no trainer-client link between these two accounts. Link them via an invite code in the app to test the full path.');
      } else {
        report(false, '8. Trainer read failed unexpectedly', tRead.data);
      }
    }
  } else {
    console.log('SKIP  8. Trainer-read test (no trainer credentials provided)');
  }

  console.log('\nDone.');
}

main().catch((e) => console.error('Script crashed:', e.message));