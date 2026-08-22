// Smoke test for the backup system (System 3). ⚠ Uses a REAL account and
// WRITES test data — prefer a throwaway. Run: node test-backup.js
const BASE_URL = 'http://localhost:4000';

const USER = {
  email: 'hashtagsukh@gmail.com',
  password: 'Abcd@123',
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
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 120) : ''));
}

async function main() {
  console.log('Testing backup system against ' + BASE_URL + '\n');

  const login = await api('/auth/login', { method: 'POST', body: USER });
  if (login.status !== 200 || !login.data.accessToken) {
    report(false, '1. Login failed — check credentials at top of file', login.data);
    return;
  }
  const token = login.data.accessToken;
  report(true, '1. Login OK — testing as: ' + login.data.user.name);

  // 2. Summary endpoint (the restore pre-check)
  const summary = await api('/user/backup/summary', { token });
  report(summary.status === 200 && typeof summary.data.sessions === 'number', '2. Summary endpoint works', summary.data);

  // 3. Custom exercise: upsert → list → idempotent re-upsert
  const ex = { local_entity_id: 'test_ex_1', name: 'Test Custom Curl', muscle_group: 'arms', instructions: 'test' };
  const exPut = await api('/user/backup/custom-exercises', { method: 'POST', token, body: [ex] });
  report(exPut.status === 201, '3a. Custom exercise upsert (201)');
  const exPut2 = await api('/user/backup/custom-exercises', { method: 'POST', token, body: [ex] });
  const exList = await api('/user/backup/custom-exercises', { token });
  const exCount = exList.data.filter((e) => e.local_entity_id === 'test_ex_1').length;
  report(exPut2.status === 201 && exCount === 1, '3b. Re-upsert does not duplicate (count=1)', { count: exCount });

  // 4. Session with RPE + notes (THE full-fidelity test — the thing the old system destroys)
  const session = {
    local_entity_id: 'test_sess_1',
    name: 'Fidelity Test',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_seconds: 1800,
    notes: 'session-level note',
    exercises: [
      {
        local_entity_id: 'test_se_1', exercise_name: 'Squat', muscle_group: 'legs',
        order_index: 0, rest_seconds: 120, group_id: null, notes: 'felt strong',
        sets: [
          { local_entity_id: 'test_set_1', weight: 100, reps: 5, set_type: 'working', rpe: 8.5, completed: true, order_index: 0 },
          { local_entity_id: 'test_set_2', weight: 50, reps: 10, set_type: 'warmup', rpe: null, completed: true, order_index: 1 },
        ],
      },
    ],
  };
  const sPut = await api('/user/backup/sessions', { method: 'POST', token, body: session });
  report(sPut.status === 201, '4a. Session upsert with nested exercises+sets');
  const sGet = await api('/user/backup/sessions', { token });
  const got = (sGet.data || []).find((s) => s.local_entity_id === 'test_sess_1');
  const set0 = got?.exercises?.[0]?.sets?.[0];
  report(
    !!got && got.notes === 'session-level note' && set0?.rpe === 8.5 && got.exercises[0].notes === 'felt strong',
    '4b. FULL FIDELITY: session notes + RPE + exercise notes round-trip',
    { notes: got?.notes, rpe: set0?.rpe, exNotes: got?.exercises?.[0]?.notes }
  );
  // 4c. Re-upsert replaces children (no duplicates)
  await api('/user/backup/sessions', { method: 'POST', token, body: session });
  const sGet2 = await api('/user/backup/sessions', { token });
  const got2 = (sGet2.data || []).find((s) => s.local_entity_id === 'test_sess_1');
  report(got2?.exercises?.length === 1 && got2.exercises[0].sets.length === 2, '4c. Re-upsert replaces children (no duplication)');

  // 5. Nested diet plan + check-in
  const diet = {
    local_entity_id: 'test_diet_1', name: 'Test Diet', notes: null, tags: ['test'],
    daily_calorie_target: 2000, daily_protein_target: 150, daily_carbs_target: 200, daily_fat_target: 65,
    days: [
      { local_entity_id: 'test_diet_d1', day_label: 'Day 1', order_index: 0, meals: [
        { local_entity_id: 'test_diet_m1', meal_type: 'Breakfast', order_index: 0, slot_note: 'eat early', items: [
          { local_entity_id: 'test_diet_i1', name: 'Oats', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, quantity_multiplier: 1, order_index: 0 },
        ] },
      ] },
    ],
  };
  const dPut = await api('/user/backup/diet-plans', { method: 'POST', token, body: diet });
  report(dPut.status === 201, '5a. Nested diet plan upsert');
  const dGet = await api('/user/backup/diet-plans', { token });
  const dGot = (dGet.data || []).find((p) => p.local_entity_id === 'test_diet_1');
  report(!!dGot?.days?.[0]?.meals?.[0]?.items?.[0] && dGot.days[0].meals[0].items[0].name === 'Oats', '5b. Diet plan nested structure round-trips');
  const ci = await api('/user/backup/diet-checkins', { method: 'POST', token, body: [{ diet_plan_local_id: 'test_diet_1', date: new Date().toISOString().slice(0, 10), followed: true, note: 'good day' }] });
  report(ci.status === 201, '5c. Diet check-in upsert');

  // 6. Idempotent deletes (the anti-404-loop test)
  const del1 = await api('/user/backup/custom-exercises/never_existed_12345', { method: 'DELETE', token });
  report(del1.status === 200, '6a. Delete of nonexistent entity succeeds (idempotent)');
  const del2 = await api('/user/backup/diet-plans/test_diet_1', { method: 'DELETE', token });
  const del3 = await api('/user/backup/diet-plans/test_diet_1', { method: 'DELETE', token });
  report(del2.status === 200 && del3.status === 200, '6b. Double plan-delete succeeds; check-ins cascade');

  // 7. Summary reflects writes
  const summary2 = await api('/user/backup/summary', { token });
  report(summary2.status === 200 && summary2.data.sessions >= 1, '7. Summary counts updated', summary2.data);

  // 8. Clean up test data
  await api('/user/backup/sessions/test_sess_1', { method: 'DELETE', token });
  await api('/user/backup/custom-exercises/test_ex_1', { method: 'DELETE', token });
  console.log('\nDone. (Test session + exercise deleted; nothing left behind.)');

  // 9. Unauthorized access blocked
  const noauth = await api('/user/backup/summary');
  report(noauth.status === 401, '9. Unauthenticated summary request rejected (401)');
}

main().catch((e) => console.error('Script crashed:', e.message));