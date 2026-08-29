// Backend tests for the outcome-first nutrition core (CommonJS mirror of
// src/features/diet/domain/nutritionCore.js) — the monitoring service's
// authoritative math. The mobile mirror is covered by test/runTests.js with
// the SAME scenarios; if one changes behavior the other must too.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/data/nutritionCore');
const digest = require('../src/data/nutritionDigest');
test('digest mirror: identical language rules server-side', () => {
  const days = [
    { dow: 'Mon', isLogged: true, calories: 2200, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Tue', isLogged: false, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    { dow: 'Wed', isLogged: true, calories: 2400, protein_g: 160, carbs_g: 220, fat_g: 70 },
  ];
  const s = digest.buildTrendSummary(days, { calories: 2200, protein_g: 180 }, 10);
  assert.strictEqual(s.avgCalories, 2300);
  assert.strictEqual(s.calorieSummary, 'right on track');
  assert.deepStrictEqual(s.notLoggedDow, ['Tue']);
});


test('tolerance boundaries are exact and inclusive (2400 ± 10%)', () => {
  assert.strictEqual(core.evaluateAgainstTarget(2160, 2400, 10), core.STATUS.ON_TARGET);
  assert.strictEqual(core.evaluateAgainstTarget(2159, 2400, 10), core.STATUS.UNDER_TARGET);
  assert.strictEqual(core.evaluateAgainstTarget(2640, 2400, 10), core.STATUS.ON_TARGET);
  assert.strictEqual(core.evaluateAgainstTarget(2641, 2400, 10), core.STATUS.OVER_TARGET);
});

test('free-logged day within tolerance is on_target with 0/N follow-through', () => {
  const entries = [{ name: 'Burger', calories: 2300, source: 'free_logged' }];
  const ft = core.computePlanFollowThrough([{ id: 'a' }, { id: 'b' }], entries);
  assert.deepStrictEqual(ft, { completed: 0, total: 2 });
  const s = core.computeDailySummary({
    date: '2026-08-29',
    entries,
    targets: { calories: 2400 },
    tolerancePct: 10,
    planFollowThrough: ft,
  });
  assert.strictEqual(s.targetStatus, core.STATUS.ON_TARGET);
});

test('no entries is not_logged, never under_target', () => {
  const s = core.computeDailySummary({ date: '2026-08-29', entries: [], targets: { calories: 2400 } });
  assert.strictEqual(s.targetStatus, core.STATUS.NOT_LOGGED);
});

test('protein miss never flips an on-target day', () => {
  const s = core.computeDailySummary({
    date: '2026-08-29',
    entries: [{ calories: 2300, protein_g: 100 }],
    targets: { calories: 2400, protein_g: 200 },
    tolerancePct: 10,
  });
  assert.strictEqual(s.targetStatus, core.STATUS.ON_TARGET);
  assert.strictEqual(s.macros.protein.status, core.STATUS.UNDER_TARGET);
});

test('monitoring: followed plan + repeated misses = plan may need review', () => {
  const days = [
    { date: 'd1', status: core.STATUS.ON_TARGET, planFollowedRatio: 1 },
    { date: 'd2', status: core.STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd3', status: core.STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd4', status: core.STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd5', status: core.STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd6', status: core.STATUS.ON_TARGET, planFollowedRatio: 1 },
    { date: 'd7', status: core.STATUS.ON_TARGET, planFollowedRatio: 1 },
  ];
  const m = core.evaluateClientMonitoring(days);
  assert.strictEqual(m.potentialPlanIssue, true);
  assert.ok(m.alerts.some((a) => a.key === 'plan_review' && a.level === 'high'));
});

test('monitoring: successful flexibility creates no negative alert', () => {
  const days = [
    { date: 'd1', status: core.STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd2', status: core.STATUS.ON_TARGET, planFollowedRatio: 0.25 },
    { date: 'd3', status: core.STATUS.UNDER_TARGET, planFollowedRatio: 0 },
    { date: 'd4', status: core.STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd5', status: core.STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd6', status: core.STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd7', status: core.STATUS.ON_TARGET, planFollowedRatio: 0 },
  ];
  const m = core.evaluateClientMonitoring(days);
  assert.strictEqual(m.successfulFlexibility, true);
  assert.strictEqual(m.potentialPlanIssue, false);
  assert.ok(!m.alerts.some((a) => a.level === 'high'));
});

test('monitoring: missing-logging streak and trailing under streak', () => {
  const m = core.evaluateClientMonitoring([
    { date: 'd1', status: core.STATUS.UNDER_TARGET, planFollowedRatio: null },
    { date: 'd2', status: core.STATUS.UNDER_TARGET, planFollowedRatio: null },
    { date: 'd3', status: core.STATUS.UNDER_TARGET, planFollowedRatio: null },
    { date: 'd4', status: core.STATUS.NOT_LOGGED, planFollowedRatio: null },
    { date: 'd5', status: core.STATUS.NOT_LOGGED, planFollowedRatio: null },
  ]);
  assert.strictEqual(m.missingLoggingStreak, 2);
  assert.ok(m.alerts.some((a) => a.key === 'missing_logging'));
  assert.strictEqual(m.repeatedUnderTarget, 3);
  assert.ok(m.alerts.some((a) => a.key === 'repeated_under'));
});

test('monitoring: simple-mode check-in days map to simple_followed/simple_missed', () => {
  const m = core.evaluateClientMonitoring([
    { date: 'd1', status: 'simple_followed', planFollowedRatio: null },
    { date: 'd2', status: 'simple_missed', planFollowedRatio: null },
    { date: 'd3', status: 'simple_followed', planFollowedRatio: null },
    { date: 'd4', status: core.STATUS.NOT_LOGGED, planFollowedRatio: null },
  ]);
  assert.strictEqual(m.daysTracked, 3);
  assert.strictEqual(m.daysOnTarget, 2);
  assert.strictEqual(m.daysUnder, 1);
});

// ---- Trainer day/week/month monitoring (spec §1–13, §24, §28) ----
const { summarizeHistory, missDirection } = require('../src/data/nutritionDigest');

test('history averages: not-logged days excluded, never zero — 2400/2300/gap/2500 → 2400', () => {
  const days = [
    { date: 'd1', dow: 'Mon', isLogged: true, calories: 2400, protein_g: 190, carbs_g: 240, fat_g: 70, status: 'on_target' },
    { date: 'd2', dow: 'Tue', isLogged: true, calories: 2300, protein_g: 185, carbs_g: 235, fat_g: 68, status: 'under_target' },
    { date: 'd3', dow: 'Wed', isLogged: false, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, status: 'not_logged' },
    { date: 'd4', dow: 'Thu', isLogged: true, calories: 2500, protein_g: 200, carbs_g: 250, fat_g: 72, status: 'over_target' },
  ];
  const s = summarizeHistory(days, { calories: 2400, protein_g: 200, carbs_g: 250, fat_g: 70 });
  assert.strictEqual(s.averages.calories, 2400); // (2400+2300+2500)/3 — NOT 1800
  assert.strictEqual(s.averages.protein_g, 192);
  assert.strictEqual(s.days_logged, 3);
  assert.strictEqual(s.days_on_target, 1);
  assert.strictEqual(s.days_under, 1); // not-logged day NOT counted as under
  assert.strictEqual(s.days_over, 1);
  assert.strictEqual(s.total_days, 4);
  assert.strictEqual(s.achievement_pct, 33);
});

test('history: not-logged days are their own status, never under_target', () => {
  const s = summarizeHistory(
    [{ date: 'd1', dow: 'Mon', isLogged: false, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, status: 'not_logged' }],
    { calories: 2400, protein_g: 200, carbs_g: 250, fat_g: 70 }
  );
  assert.strictEqual(s.days[0].status, 'not_logged');
  assert.strictEqual(s.days_under, 0);
  assert.strictEqual(s.days_on_target, 0);
  assert.strictEqual(s.averages.calories, null); // no logged days → no average
  assert.strictEqual(s.achievement_pct, null);
});

test('notification direction: target miss notifies, on-target and not-logged never do', () => {
  assert.strictEqual(missDirection('under_target'), 'under');
  assert.strictEqual(missDirection('over_target'), 'over');
  // §28 "Target achieved with different foods": on target with 0/4 plan
  // meals followed is still on_target → NO negative notification
  assert.strictEqual(missDirection('on_target'), null);
  // §28 "Not logged": a day with no entries is Not Logged, never Under Target
  assert.strictEqual(missDirection('not_logged'), null);
});
