// Plain-Node unit tests for the pure logic (no React Native required).
// Run: npm test
import assert from 'node:assert';
import { plateBreakdown } from '../src/lib/plates.js';
import { e1rm, avgRpe, rpeInsight } from '../src/lib/stats.js';
import linear from '../src/progressionFormulas/linearProgression.js';
import double from '../src/progressionFormulas/doubleProgression.js';
import rpe from '../src/progressionFormulas/rpeAutoregulated.js';
import percentage from '../src/progressionFormulas/percentageBased.js';
import { positionalPrevs } from '../src/store/prefillSets.js';
import {
  resolveActiveMembershipRow,
  summarizeAttendance,
  statusColor,
} from '../src/lib/gymState.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('✓', name);
};

// ---- Plate calculator ----
test('135 lb with 45 lb bar = one 45 plate per side', () => {
  const r = plateBreakdown(135, 45, [45, 35, 25, 10, 5, 2.5]);
  assert.deepStrictEqual(r.perSide, [{ size: 45, count: 1 }]);
  assert.ok(r.exact);
});

test('225 lb with 45 lb bar = two 45 plates per side', () => {
  const r = plateBreakdown(225, 45, [45, 35, 25, 10, 5, 2.5]);
  assert.deepStrictEqual(r.perSide, [{ size: 45, count: 2 }]);
  assert.ok(r.exact);
});

test('100 kg with 20 kg bar = two 20 kg plates per side', () => {
  const r = plateBreakdown(100, 20, [20, 15, 10, 5, 2.5, 1.25]);
  assert.deepStrictEqual(r.perSide, [{ size: 20, count: 2 }]);
  assert.ok(r.exact);
});

test('85 kg with 20 kg bar = 20+10+2.5 per side (32.5)', () => {
  const r = plateBreakdown(85, 20, [20, 15, 10, 5, 2.5, 1.25]);
  assert.deepStrictEqual(r.perSide, [
    { size: 20, count: 1 },
    { size: 10, count: 1 },
    { size: 2.5, count: 1 },
  ]);
  assert.ok(r.exact);
});

test('uneven remainder is reported, not silently matched', () => {
  const r = plateBreakdown(103, 20, [20, 15, 10, 5]); // 41.5/side → 20+15+5 = 40, 1.5 left
  assert.strictEqual(r.leftover, 1.5);
  assert.ok(!r.exact);
});

test('weights below bar weight show belowBar, no negative breakdown', () => {
  const r = plateBreakdown(30, 45, [45, 25, 10]);
  assert.ok(r.belowBar);
  assert.deepStrictEqual(r.perSide, []);
});

// ---- Stats: e1RM / RPE (warmup exclusion itself is enforced by SQL filters;
// these tests cover the math and the NULL-rpe handling rules) ----
test('e1rm Epley formula', () => {
  assert.ok(Math.abs(e1rm(100, 10) - 133.33) < 0.01); // 100 * (1 + 10/30)
});

test('avgRpe excludes NULL and NaN, returns null when empty', () => {
  assert.strictEqual(avgRpe([]), null);
  assert.strictEqual(avgRpe([null, undefined]), null);
  assert.ok(Math.abs(avgRpe([7, null, 8, 8]) - 7.667) < 0.001);
});

test('rpeInsight: low average suggests progression', () => {
  const rows = [{ rpe: 7 }, { rpe: 7 }, { rpe: 8 }, { rpe: 7.5 }];
  const msg = rpeInsight(rows);
  assert.ok(msg && msg.includes('RPE 7.5'));
});

test('rpeInsight: high average suggests holding load', () => {
  const rows = [{ rpe: 9 }, { rpe: 9.5 }, { rpe: 9.5 }];
  const msg = rpeInsight(rows);
  assert.ok(msg && msg.includes('reducing'));
});

test('rpeInsight: NULL-heavy data yields no insight', () => {
  assert.strictEqual(rpeInsight([{ rpe: null }, { rpe: 8 }]), null);
});

// ---- Progression: weight-group-aware formulas + positional prefill ----
// REGRESSION CASE (ramp structure): Session A = Bench Press
//   10kg×10, 10kg×10, 20kg×4, 20kg×4 — all completed, all 'working'.
const rampSession = [
  { weight: 10, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
  { weight: 10, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
  { weight: 20, reps: 4, completed: true, setType: 'working', sessionIndex: 0 },
  { weight: 20, reps: 4, completed: true, setType: 'working', sessionIndex: 0 },
];

test('Fix 1: positional prefill matches each set position (ramp case)', () => {
  const prevs = positionalPrevs(rampSession);
  assert.deepStrictEqual(prevs, [
    { weight: 10, reps: 10, rpe: null },
    { weight: 10, reps: 10, rpe: null },
    { weight: 20, reps: 4, rpe: null },
    { weight: 20, reps: 4, rpe: null },
  ]);
});

test('Fix 1: uniform sets still prefill positionally (no regression)', () => {
  const uniform = [1, 2, 3, 4].map((position) => ({
    weight: 60, reps: 8, completed: true, setType: 'working', position,
  }));
  assert.deepStrictEqual(
    positionalPrevs(uniform),
    [1, 2, 3, 4].map(() => ({ weight: 60, reps: 8, rpe: null }))
  );
});

test('Fix 1: blank prior rows are skipped for prefill', () => {
  const rows = [
    { weight: 0, reps: 0, completed: 0, position: 0 },
    { weight: 60, reps: 8, completed: 1, position: 1 },
  ];
  assert.deepStrictEqual(positionalPrevs(rows), [{ weight: 60, reps: 8, rpe: null }]);
});

test('Fix 2 Linear: ramp case bases suggestion on TOP group (never 10kg)', () => {
  const r = linear.calculate(structuredClone(rampSession), { incrementKg: 2.5 });
  // top group 20kg×4, below the 10-rep threshold → same weight, +1 rep
  assert.strictEqual(r.suggestedWeight, 20);
  assert.strictEqual(r.suggestedReps, 5);
});

test('Fix 2 Linear: reps < threshold → same weight +1 rep', () => {
  const hist = [
    { weight: 20, reps: 6, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 6, completed: true, setType: 'working', sessionIndex: 0 },
  ];
  const r = linear.calculate(hist, { incrementKg: 2.5 });
  assert.strictEqual(r.suggestedWeight, 20); // same top-group weight
  assert.strictEqual(r.suggestedReps, 7); // nudge reps up
});

test('Fix 2 Linear: reps >= threshold (10) → add weight FROM top group', () => {
  const hist = [
    { weight: 10, reps: 12, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
  ];
  const r = linear.calculate(hist, { incrementKg: 2.5 });
  assert.strictEqual(r.suggestedWeight, 22.5); // increase from 20, not 10
  assert.strictEqual(r.suggestedReps, 10);
});

test('Fix 2 Linear: uneven top group repeats TOP group weight', () => {
  const hist = [
    { weight: 10, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 6, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 4, completed: true, setType: 'working', sessionIndex: 0 },
  ];
  const r = linear.calculate(hist, { incrementKg: 2.5 });
  assert.strictEqual(r.suggestedWeight, 20); // repeat top weight, never 10
  assert.strictEqual(r.suggestedReps, 6); // aim for the group's best
});

test('Fix 2 Linear: single-weight session — reps before weight, then weight up', () => {
  const uniform = [1, 2, 3].map(() => ({
    weight: 60, reps: 8, completed: true, setType: 'working', sessionIndex: 0,
  }));
  const r = linear.calculate(uniform, { incrementKg: 2.5 });
  assert.strictEqual(r.suggestedWeight, 60); // 8 reps < 10 → same weight
  assert.strictEqual(r.suggestedReps, 9); // +1 rep
  const atThreshold = [1, 2].map(() => ({
    weight: 60, reps: 10, completed: true, setType: 'working', sessionIndex: 0,
  }));
  const rUp = linear.calculate(atThreshold, { incrementKg: 2.5 });
  assert.strictEqual(rUp.suggestedWeight, 62.5); // hit 10 → add weight
});

test('Fix 2 Linear: warmup sets are excluded from grouping entirely', () => {
  const hist = [
    { weight: 40, reps: 10, completed: true, setType: 'warmup', sessionIndex: 0 },
    { weight: 20, reps: 6, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 6, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 5, completed: true, setType: 'working', sessionIndex: 0 },
  ];
  const r = linear.calculate(hist, { incrementKg: 2.5 });
  // warmup at 40kg must NOT become the "top group"; top working group is 20kg,
  // uneven (6,6,5) → repeat 20 aiming for 6.
  assert.strictEqual(r.suggestedWeight, 20);
  assert.strictEqual(r.suggestedReps, 6);});

test('Fix 2 Double: ramp case evaluates only the top group', () => {
  const r = double.calculate(structuredClone(rampSession), { repMin: 8, repMax: 12, incrementKg: 2.5 });
  // top group 20kg×4 — below range → same weight, nudge reps to 5
  assert.strictEqual(r.suggestedWeight, 20);
  assert.strictEqual(r.suggestedReps, 5);
  const hitTop = [
    { weight: 10, reps: 10, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 12, completed: true, setType: 'working', sessionIndex: 0 },
    { weight: 20, reps: 12, completed: true, setType: 'working', sessionIndex: 0 },
  ];
  const r2 = double.calculate(hitTop, { repMin: 8, repMax: 12, incrementKg: 2.5 });
  assert.strictEqual(r2.suggestedWeight, 22.5); // increase FROM 20, not 10
});

test('Fix 2 RPE: judged on top group; no-RPE falls back to linear', () => {
  const easyRamp = rampSession.map((s) => ({ ...s, rpe: 7 }));
  const r = rpe.calculate(easyRamp, { incrementKg: 2.5 });
  assert.strictEqual(r.suggestedWeight, 22.5); // RPE path adds weight from 20, not 10
  const noRpe = rpe.calculate(structuredClone(rampSession), { incrementKg: 2.5 });
  // linear fallback: 4 reps < threshold → same weight, +1 rep
  assert.strictEqual(noRpe.suggestedWeight, 20);
  assert.strictEqual(noRpe.suggestedReps, 5);
});

test('Fix 2 Percentage-Based: training-max driven, unaffected by ramps', () => {
  const wk = (n) => Date.now() - n * 86400000;
  const hist = structuredClone(rampSession).map((s) => ({ ...s, trainingMax: 100, performedAt: wk(0) }));
  const r = percentage.calculate(hist, {});
  assert.strictEqual(r.suggestedWeight, 70);
});

// ---- Check-in per-date independence + future-date blocking ----
// Regression tests for the diet/supplement check-in bug: a single plan-wide
// answer bled into every date's display, and future dates were answerable.
import { todayLocalISO, isFutureDate, buildCheckinMap } from '../src/lib/checkinDates.js';

const T = todayLocalISO(); // real device "today", local calendar
const dayOffset = (base, n) => {
  const d = new Date(`${base}T12:00:00`); // noon anchor: immune to DST edges
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('check-in: todayLocalISO returns the LOCAL calendar date (not UTC)', () => {
  // at 00:30 local in UTC+5:30, toISOString() still shows YESTERDAY in UTC;
  // local components must win. Verify format and self-consistency.
  assert.match(T, /^\d{4}-\d{2}-\d{2}$/);
  const now = new Date();
  assert.strictEqual(
    T,
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  );
});

test('check-in: future dates blocked, past/today allowed — even near midnight', () => {
  // 11:58 PM case: today itself must never read as future regardless of
  // time-of-day, because comparison is DATE-ONLY on local calendar strings
  assert.strictEqual(isFutureDate(T), false);
  assert.strictEqual(isFutureDate(dayOffset(T, -1)), false); // past backfill ok
  assert.strictEqual(isFutureDate(dayOffset(T, -30)), false);
  assert.strictEqual(isFutureDate(dayOffset(T, 1)), true); // tomorrow
  assert.strictEqual(isFutureDate(dayOffset(T, 3)), true); // Aug-27-style repro
  // lexicographic safety across month/year boundaries
  assert.strictEqual(isFutureDate('2026-08-24', '2026-09-01'), false);
  assert.strictEqual(isFutureDate('2026-10-01', '2026-09-01'), true);
  assert.strictEqual(isFutureDate('2027-01-01', '2026-12-31'), true);
});

test('check-in: exact reproduction — Aug22 No / Aug24 Yes stay independent', () => {
  // seed rows exactly like the bug report: No on the 22nd, later Yes on the
  // 24th; every other date must remain UNANSWERED and the 22nd must keep No
  const rows = [
    { date: '2026-08-22', followed: false },
    { date: '2026-08-24', followed: true },
  ];
  const map = buildCheckinMap(rows);
  assert.strictEqual(map['2026-08-22'], false); // keeps its own No
  assert.strictEqual(map['2026-08-24'], true); // keeps its own Yes
  assert.ok(!('2026-08-23' in map)); // never answered → unanswered
  assert.ok(!('2026-08-25' in map));
  assert.ok(!('2026-08-27' in map)); // future date has NO state at all
});

test('check-in: four dates, mixed answers, random-order reads never bleed', () => {
  const rows = [
    { date: '2026-08-20', followed: true },
    { date: '2026-08-21', followed: false },
    { date: '2026-08-23', followed: true },
    { date: '2026-08-24', followed: false },
  ];
  const map = buildCheckinMap(rows);
  // deliberately non-chronological reads
  const reads = ['2026-08-24', '2026-08-20', '2026-08-23', '2026-08-21'];
  const expected = { '2026-08-24': false, '2026-08-20': true, '2026-08-23': true, '2026-08-21': false };
  for (const d of reads) {
    assert.strictEqual(map[d], expected[d], `${d} must show only its own answer`);
  }
  // writing one more date mutates ONLY that key
  const after = { ...map };
  after['2026-08-22'] = false; // simulates checkIn(false) on Aug 22
  assert.strictEqual(after['2026-08-22'], false);
  assert.strictEqual(after['2026-08-24'], false); // untouched by the new write
  assert.strictEqual(after['2026-08-20'], true);
});

test('check-in: supplement rows (taken) and SQLite ints both map correctly', () => {
  // API shape: taken true/false · local SQLite shape: followed 1/0
  const supp = buildCheckinMap([{ date: '2026-08-22', taken: false }, { date: '2026-08-24', taken: true }], 'taken');
  assert.strictEqual(supp['2026-08-22'], false);
  assert.strictEqual(supp['2026-08-24'], true);
  const sqlite = buildCheckinMap([
    { date: '2026-08-22T00:00:00.000Z', followed: 0 },
    { date: '2026-08-24', followed: 1 },
  ]);
  assert.strictEqual(sqlite['2026-08-22'], false);
  assert.strictEqual(sqlite['2026-08-24'], true);
  // null/absent values must read as UNANSWERED, not coerced to No
  const partial = buildCheckinMap([{ date: '2026-08-22', followed: null }]);
  assert.ok(!('2026-08-22' in partial));
});

// ---- Diet nutrition core (outcome-first tracking) ----
import {
  evaluateAgainstTarget,
  computePlanFollowThrough,
  computeDailySummary,
  computeWeeklySummary,
  evaluateClientMonitoring,
  detectRepeatedMacroMisses,
  buildRecentFoods,
  suggestFoodsToFit,
  STATUS,
} from '../src/features/diet/domain/nutritionCore.js';

// Test 6 (spec): tolerance boundary, target 2400 ± 10% → 2160 / 2640.
test('nutrition: tolerance boundaries are exact and inclusive', () => {
  assert.strictEqual(evaluateAgainstTarget(2160, 2400, 10), STATUS.ON_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2159, 2400, 10), STATUS.UNDER_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2640, 2400, 10), STATUS.ON_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2641, 2400, 10), STATUS.OVER_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2400, 2400, 10), STATUS.ON_TARGET);
});

test('nutrition: tolerance is configurable per plan', () => {
  // strict 5%: 2400 → 2280/2520
  assert.strictEqual(evaluateAgainstTarget(2279, 2400, 5), STATUS.UNDER_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2280, 2400, 5), STATUS.ON_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2520, 2400, 5), STATUS.ON_TARGET);
  assert.strictEqual(evaluateAgainstTarget(2521, 2400, 5), STATUS.OVER_TARGET);
});

// Test 1 (spec): only free-logged foods, calories within tolerance.
test('nutrition: free-logged foods that hit the target = on_target, follow-through 0/N', () => {
  const entries = [
    { name: 'Burger', calories: 1400, protein_g: 60, carbs_g: 100, fat_g: 70, source: 'free_logged' },
    { name: 'Fries', calories: 900, protein_g: 10, carbs_g: 110, fat_g: 40, source: 'free_logged' },
  ];
  const plannedItems = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const s = computeDailySummary({
    date: '2026-08-29',
    entries,
    targets: { calories: 2400, protein_g: 200, carbs_g: 250, fat_g: 70 },
    tolerancePct: 10,
    planFollowThrough: computePlanFollowThrough(plannedItems, entries),
  });
  assert.strictEqual(s.targetStatus, STATUS.ON_TARGET);
  assert.strictEqual(s.planFollowThrough.completed, 0);
  assert.strictEqual(s.planFollowThrough.total, 4);
  // the model communicates this positively, never as failure
  assert.strictEqual(s.contextualInsight, 'You reached your targets with different foods today.');
});

// Test 2 (spec): all meals followed, calories within tolerance.
test('nutrition: fully followed plan within tolerance = on_target, N/N followed', () => {
  const entries = [
    { name: 'Oatmeal', calories: 1200, source: 'planned', planned_item_ref: 'a' },
    { name: 'Chicken Bowl', calories: 1200, source: 'planned', planned_item_ref: 'b' },
  ];
  const plannedItems = [{ id: 'a', name: 'Oatmeal' }, { id: 'b', name: 'Chicken Bowl' }];
  const s = computeDailySummary({
    date: '2026-08-29',
    entries,
    targets: { calories: 2400 },
    tolerancePct: 10,
    planFollowThrough: computePlanFollowThrough(plannedItems, entries),
  });
  assert.strictEqual(s.targetStatus, STATUS.ON_TARGET);
  assert.strictEqual(s.planFollowThrough.completed, 2);
  assert.strictEqual(s.planFollowThrough.total, 2);
  assert.strictEqual(s.contextualInsight, null); // no motivational spam
});

// Test 3 (spec): all meals followed, calories below tolerance.
test('nutrition: fully followed plan below tolerance = under_target', () => {
  const entries = [{ name: 'Oatmeal', calories: 2000, source: 'planned', planned_item_ref: 'a' }];
  const plannedItems = [{ id: 'a', name: 'Oatmeal' }];
  const s = computeDailySummary({
    date: '2026-08-29',
    entries,
    targets: { calories: 2400 },
    tolerancePct: 10,
    planFollowThrough: computePlanFollowThrough(plannedItems, entries),
  });
  assert.strictEqual(s.targetStatus, STATUS.UNDER_TARGET);
  assert.strictEqual(s.planFollowThrough.completed, 1);
  assert.strictEqual(s.contextualInsight, 'You followed the planned meals, but the day’s nutrition target was missed.');
});

// Test 4 (spec): no entries → not_logged, NEVER under_target.
test('nutrition: no entries = not_logged, never under_target or 0%', () => {
  const s = computeDailySummary({
    date: '2026-08-29',
    entries: [],
    targets: { calories: 2400 },
    tolerancePct: 10,
  });
  assert.strictEqual(s.targetStatus, STATUS.NOT_LOGGED);
  assert.strictEqual(s.isLogged, false);
  assert.strictEqual(s.calories.actual, 0);
});

// Test 5 (spec): calories on target, protein below — headline stays on_target.
test('nutrition: protein miss never flips an on-target day to under', () => {
  const entries = [
    { name: 'Pasta', calories: 2300, protein_g: 100, carbs_g: 240, fat_g: 65, source: 'free_logged' },
  ];
  const s = computeDailySummary({
    date: '2026-08-29',
    entries,
    targets: { calories: 2400, protein_g: 200, carbs_g: 250, fat_g: 70 },
    tolerancePct: 10,
  });
  assert.strictEqual(s.targetStatus, STATUS.ON_TARGET);
  assert.strictEqual(s.macros.protein.status, STATUS.UNDER_TARGET);
  assert.strictEqual(s.macros.carbs.status, STATUS.ON_TARGET);
});

test('nutrition: today shows progress, not a final under-target verdict', () => {
  const s = computeDailySummary({
    date: '2026-08-29',
    entries: [{ name: 'Eggs', calories: 600, source: 'free_logged' }],
    targets: { calories: 2400 },
    tolerancePct: 10,
    isToday: true,
  });
  assert.strictEqual(s.targetStatus, STATUS.IN_PROGRESS);
  assert.strictEqual(s.calories.remaining, 1800);
  // the same data on a COMPLETED day is a genuine under-target
  const done = computeDailySummary({
    date: '2026-08-29',
    entries: [{ name: 'Eggs', calories: 600, source: 'free_logged' }],
    targets: { calories: 2400 },
    tolerancePct: 10,
    isToday: false,
  });
  assert.strictEqual(done.targetStatus, STATUS.UNDER_TARGET);
});

test('nutrition: plan follow-through counts name matches, never extras', () => {
  const plannedItems = [{ id: 'a', name: 'Oatmeal' }, { id: 'b', name: 'Chicken Bowl' }];
  const entries = [
    { name: 'oatmeal ', calories: 300, source: 'free_logged' }, // name match counts
    { name: 'Ice cream', calories: 400, source: 'extra' }, // extras never reduce
  ];
  const ft = computePlanFollowThrough(plannedItems, entries);
  assert.strictEqual(ft.completed, 1);
  assert.strictEqual(ft.total, 2);
  // total === 0 → null (UI omits the section, never renders "0 / 0")
  assert.strictEqual(computePlanFollowThrough([], entries), null);
});

test('nutrition: weekly summary counts and insight', () => {
  const mk = (date, status, isLogged, followThrough) => ({
    date,
    isLogged,
    targetStatus: status,
    calories: { actual: isLogged ? 2300 : 0, target: 2400, remaining: 100, over: 0, status: null },
    macros: {},
    planFollowThrough: followThrough,
  });
  const days = [
    mk('2026-08-22', STATUS.ON_TARGET, true, { completed: 4, total: 4 }),
    mk('2026-08-23', STATUS.ON_TARGET, true, { completed: 1, total: 4 }),
    mk('2026-08-24', STATUS.UNDER_TARGET, true, { completed: 4, total: 4 }),
    mk('2026-08-25', STATUS.ON_TARGET, true, { completed: 0, total: 4 }),
    mk('2026-08-26', STATUS.NOT_LOGGED, false, null),
    mk('2026-08-27', STATUS.ON_TARGET, true, { completed: 2, total: 4 }),
    mk('2026-08-28', STATUS.NOT_LOGGED, false, null),
  ];
  const w = computeWeeklySummary(days);
  assert.strictEqual(w.tracked, 5);
  assert.strictEqual(w.onTarget, 4);
  assert.strictEqual(w.under, 1);
  assert.strictEqual(w.notLogged, 2);
  assert.strictEqual(w.planFollowedDays, 2); // >= 80% items
  assert.strictEqual(w.hitOnDifferentFoods, 2); // on target with < 50% follow-through
  assert.ok(w.avgCalories === 2300);
  assert.ok(w.insight.includes('4 of 5 tracked days'));
  assert.ok(w.insight.includes("didn't follow the planned meals"));
});

// Test 7 (spec): plan followed 6/7 days, target missed 4/7 → plan issue.
test('monitoring: followed plan + missed targets = plan may need review', () => {
  const days = [
    { date: 'd1', status: STATUS.ON_TARGET, planFollowedRatio: 1 },
    { date: 'd2', status: STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd3', status: STATUS.UNDER_TARGET, planFollowedRatio: 1 },
    { date: 'd4', status: STATUS.UNDER_TARGET, planFollowedRatio: 0.75 },
    { date: 'd5', status: STATUS.OVER_TARGET, planFollowedRatio: 1 },
    { date: 'd6', status: STATUS.ON_TARGET, planFollowedRatio: 1 },
    { date: 'd7', status: STATUS.ON_TARGET, planFollowedRatio: 1 },
  ];
  const m = evaluateClientMonitoring(days);
  assert.strictEqual(m.potentialPlanIssue, true);
  assert.ok(m.alerts.some((a) => a.key === 'plan_review' && a.level === 'high'));
  assert.strictEqual(m.successfulFlexibility, false);
});

// Test 8 (spec): plan followed 2/7, target hit 6/7 → successful flexibility,
// and NO negative alert.
test('monitoring: hit targets with different foods = successful flexibility, no red flag', () => {
  const days = [
    { date: 'd1', status: STATUS.ON_TARGET, planFollowedRatio: 0.5 },
    { date: 'd2', status: STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd3', status: STATUS.UNDER_TARGET, planFollowedRatio: 0.25 },
    { date: 'd4', status: STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd5', status: STATUS.ON_TARGET, planFollowedRatio: 0 },
    { date: 'd6', status: STATUS.ON_TARGET, planFollowedRatio: 0.25 },
    { date: 'd7', status: STATUS.ON_TARGET, planFollowedRatio: 0 },
  ];
  const m = evaluateClientMonitoring(days);
  assert.strictEqual(m.successfulFlexibility, true);
  assert.strictEqual(m.potentialPlanIssue, false);
  assert.ok(!m.alerts.some((a) => a.level === 'high'));
});

test('monitoring: missing logging streak and repeated under/over', () => {
  const gap = [
    { date: 'd1', status: STATUS.ON_TARGET, planFollowedRatio: null },
    { date: 'd2', status: STATUS.NOT_LOGGED, planFollowedRatio: null },
    { date: 'd3', status: STATUS.NOT_LOGGED, planFollowedRatio: null },
    { date: 'd4', status: STATUS.NOT_LOGGED, planFollowedRatio: null },
  ];
  let m = evaluateClientMonitoring(gap);
  assert.strictEqual(m.missingLoggingStreak, 3);
  assert.ok(m.alerts.some((a) => a.key === 'missing_logging' && a.level === 'high'));

  const under = [
    { date: 'd1', status: STATUS.UNDER_TARGET, planFollowedRatio: null },
    { date: 'd2', status: STATUS.NOT_LOGGED, planFollowedRatio: null }, // neither extends nor breaks
    { date: 'd3', status: STATUS.UNDER_TARGET, planFollowedRatio: null },
    { date: 'd4', status: STATUS.UNDER_TARGET, planFollowedRatio: null },
  ];
  m = evaluateClientMonitoring(under);
  assert.strictEqual(m.repeatedUnderTarget, 3);
  assert.ok(m.alerts.some((a) => a.key === 'repeated_under'));

  const over = [
    { date: 'd1', status: STATUS.OVER_TARGET, planFollowedRatio: null },
    { date: 'd2', status: STATUS.OVER_TARGET, planFollowedRatio: null },
    { date: 'd3', status: STATUS.OVER_TARGET, planFollowedRatio: null },
  ];
  m = evaluateClientMonitoring(over);
  assert.ok(m.alerts.some((a) => a.key === 'repeated_over'));
});

test('monitoring: repeated macro deficiency across last 4 logged days', () => {
  const out = detectRepeatedMacroMisses(
    [
      { date: 'd1', misses: { protein: true } },
      { date: 'd2', misses: { protein: true } },
      { date: 'd3', misses: { protein: false } },
      { date: 'd4', misses: { protein: true } },
    ],
    ['protein', 'carbs']
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].macro, 'protein');
  assert.strictEqual(out[0].level, 'medium');
  assert.strictEqual(out[0].misses, 3);
});

test('nutrition: recent foods keep the last quantity (quantity memory)', () => {
  const recents = buildRecentFoods([
    { name: 'Chicken breast', quantity: 200, calories: 330, logged_at: 100 },
    { name: 'Rice', quantity: 150, calories: 195, logged_at: 200 },
    { name: 'Chicken breast', quantity: 250, calories: 413, logged_at: 300 },
  ]);
  assert.strictEqual(recents.length, 2);
  assert.strictEqual(recents[0].name, 'Chicken breast'); // most recent first
  assert.strictEqual(recents[0].quantity, 250); // latest quantity wins
});

test('nutrition: find-food-to-fit ranks by budget fit and protein', () => {
  const suggestions = suggestFoodsToFit(
    { calories: 220, protein_g: 28 },
    [
      { name: 'Greek yogurt', calories: 150, protein_g: 17 },
      { name: 'Banana', calories: 105, protein_g: 1 },
      { name: 'Big pizza', calories: 900, protein_g: 30 }, // blows the budget
      { name: 'Chicken breast', calories: 230, protein_g: 43 },
    ],
    3
  );
  assert.strictEqual(suggestions.length, 3);
  assert.ok(!suggestions.some((s) => s.name === 'Big pizza'));
  // protein-dense chicken outranks the same-calorie yogurt
  assert.strictEqual(suggestions[0].name, 'Chicken breast');
});

console.log(`\n${passed} tests passed`);

// ---- Nutrition profile & automatic target calculation ----
import {
  calculateRecommendation,
  validateNutritionProfile,
  validateProvidedNutritionFields,
  recommendationInputsChanged,
} from '../src/features/diet/domain/nutritionTargets.js';

test('targets: Mifflin-St Jeor + activity + deficit produces the documented example', () => {
  // 82kg, 178cm, 27y male, moderately active, standard fat loss:
  // BMR 1803 → TDEE 2794 → −20% ≈ 2235 → floored/rounded 2240
  const r = calculateRecommendation({
    age: 27, gender: 'male', height_cm: 178, weight_kg: 82,
    activity_level: 'moderate', primary_goal: 'weight_loss', goal_intensity: 'standard',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.recommendation.calories, 2240);
  assert.strictEqual(r.recommendation.protein_g, 164); // 2.0 g/kg
  assert.ok(r.recommendation.fat_g >= 41); // ≥ 0.5 g/kg floor
  assert.ok(r.recommendation.carbs_g > 0);
  // internal math is carried for reference but the UI shows only final numbers
  assert.strictEqual(r.details.tdee, 2794);
});

test('targets: incomplete profile never fabricates a recommendation', () => {
  const r = calculateRecommendation({ age: 27, gender: 'male' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('height_cm'));
  assert.ok(r.missing.includes('weight_kg'));
  assert.ok(r.missing.includes('activity_level'));
  assert.ok(r.missing.includes('primary_goal'));
  assert.strictEqual(r.recommendation, null);
});

test('targets: out-of-range values are rejected, not silently accepted', () => {
  assert.strictEqual(validateNutritionProfile({ age: 5, gender: 'male', height_cm: 178, weight_kg: 82, activity_level: 'light', primary_goal: 'muscle_gain' }).ok, false);
  assert.strictEqual(validateNutritionProfile({ age: 30, gender: 'male', height_cm: 50, weight_kg: 82, activity_level: 'light', primary_goal: 'muscle_gain' }).ok, false);
  assert.strictEqual(validateNutritionProfile({ age: 30, gender: 'male', height_cm: 178, weight_kg: 82, activity_level: 'light', primary_goal: 'muscle_gain', goal_intensity: 'turbo' }).ok, false);
});

test('targets: partial profile saves validate only provided fields', () => {
  // gate mode may save only allergens — no nutrition fields → valid
  assert.strictEqual(validateProvidedNutritionFields({}).ok, true);
  assert.strictEqual(validateProvidedNutritionFields({ age: 200 }).ok, false);
  assert.strictEqual(validateProvidedNutritionFields({ weight_kg: 82 }).ok, true);
});

test('targets: female calorie floor (1200) and surplus goal adjustments', () => {
  // small, sedentary female cutting aggressively must never go below 1200
  const r = calculateRecommendation({
    age: 60, gender: 'female', height_cm: 150, weight_kg: 55,
    activity_level: 'sedentary', primary_goal: 'weight_loss', goal_intensity: 'aggressive',
  });
  assert.ok(r.recommendation.calories >= 1200);
  // gentle surplus for muscle gain exceeds steady surplus
  const mild = calculateRecommendation({ age: 25, gender: 'male', height_cm: 180, weight_kg: 70, activity_level: 'moderate', primary_goal: 'muscle_gain', goal_intensity: 'mild' });
  const aggressive = calculateRecommendation({ age: 25, gender: 'male', height_cm: 180, weight_kg: 70, activity_level: 'moderate', primary_goal: 'muscle_gain', goal_intensity: 'aggressive' });
  assert.ok(aggressive.recommendation.calories > mild.recommendation.calories);
});

test('targets: weight change alters the recommendation inputs comparison', () => {
  assert.strictEqual(recommendationInputsChanged({ weight_kg: 82 }, { weight_kg: 79 }), true);
  assert.strictEqual(recommendationInputsChanged({ weight_kg: 82, activity_level: 'light' }, { weight_kg: 82, activity_level: 'light' }), false);
  // string vs number representations of the same value are equal
  assert.strictEqual(recommendationInputsChanged({ weight_kg: '82' }, { weight_kg: 82 }), false);
  assert.strictEqual(recommendationInputsChanged({ primary_goal: 'muscle_gain' }, { primary_goal: 'weight_loss' }), true);
});

// ---- Trend-based progress (log-first model) ----
import { buildTrendSummary } from '../src/features/diet/domain/nutritionCore.js';

test('trend: not-logged days are excluded from averages, never counted as zero', () => {
  const days = [
    { dow: 'Mon', isLogged: true, calories: 2200, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Tue', isLogged: false, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    { dow: 'Wed', isLogged: true, calories: 2400, protein_g: 160, carbs_g: 220, fat_g: 70 },
  ];
  const s = buildTrendSummary(days, { calories: 2200, protein_g: 180, carbs_g: 250, fat_g: 70 }, 10);
  // average over LOGGED days only: (2200+2400)/2 = 2300 — a zero for Tue would give 1533
  assert.strictEqual(s.avgCalories, 2300);
  assert.strictEqual(s.loggedDays, 2);
  assert.deepStrictEqual(s.notLoggedDow, ['Tue']);
  assert.strictEqual(s.withinTolerance, true);
  assert.strictEqual(s.calorieSummary, 'right on track');
});

test('trend: declining-protein data produces the low-protein trend note', () => {
  const days = [0, 1, 2].map((i) => ({
    dow: ['Mon', 'Tue', 'Wed'][i],
    isLogged: true,
    calories: 2200,
    protein_g: 180 - i * 30, // 180 → 150 → 120, avg 150 vs 180 target = well below
    carbs_g: 250,
    fat_g: 70,
  }));
  const s = buildTrendSummary(days, { calories: 2200, protein_g: 180 }, 10);
  assert.ok(s.notes.some((n) => n.startsWith('Protein has been trending a little low')));
});

test('trend: no target → totals without verdict language', () => {
  const s = buildTrendSummary([{ dow: 'Mon', isLogged: true, calories: 1800 }], null, 10);
  assert.strictEqual(s.avgCalories, 1800);
  assert.strictEqual(s.calorieSummary, null);
  assert.strictEqual(s.notes.length, 0);
});

test('trend: recent 3-day improvement reads as moving toward target', () => {
  const days = [
    { dow: 'Mon', isLogged: true, calories: 2600, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Tue', isLogged: true, calories: 2700, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Wed', isLogged: true, calories: 2600, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Thu', isLogged: true, calories: 2400, protein_g: 150, carbs_g: 200, fat_g: 60 },
    { dow: 'Fri', isLogged: true, calories: 2300, protein_g: 150, carbs_g: 200, fat_g: 60 },
  ];
  const s = buildTrendSummary(days, { calories: 2200 }, 10);
  // avg 2520 → above target, but the recent 3 days (2300) sit closer to 2200
  // than the first 3 (2633) — trending DOWN toward target, not "trending high"
  assert.strictEqual(s.calorieSummary, 'trending down toward target');
});

// ---- Gym state derivation (Mobile M1) ----
const GYM_ROWS = [
  { gym_id: 'g-a', gym_name: 'Alpha Gym', member_code: 'GM-1', membership_status: 'FROZEN', status: 'ACTIVE', ends_on: '2026-02-01' },
  { gym_id: 'g-b', gym_name: 'Beta Gym', member_code: 'GM-2', membership_status: 'ACTIVE', status: 'ACTIVE', ends_on: '2026-03-01' },
];

test('gym: first ACTIVE membership term wins when no preference', () => {
  const row = resolveActiveMembershipRow(GYM_ROWS);
  assert.strictEqual(row.gym_id, 'g-b');
});

test('gym: explicit gym selection (multi-gym) wins while still present', () => {
  const row = resolveActiveMembershipRow(GYM_ROWS, 'g-a');
  assert.strictEqual(row.gym_id, 'g-a');
});

test('gym: stale selection falls back to the derived active row', () => {
  const row = resolveActiveMembershipRow(GYM_ROWS, 'g-gone');
  assert.strictEqual(row.gym_id, 'g-b');
});

test('gym: no ACTIVE term anywhere falls back to the first row', () => {
  const rows = [
    { gym_id: 'g-x', membership_status: null, status: 'PENDING' },
    { gym_id: 'g-y', membership_status: null, status: 'FROZEN' },
  ];
  assert.strictEqual(resolveActiveMembershipRow(rows).gym_id, 'g-x');
});

test('gym: empty/absent rows resolve to null (standalone user)', () => {
  assert.strictEqual(resolveActiveMembershipRow([]), null);
  assert.strictEqual(resolveActiveMembershipRow(null), null);
});

test('gym: unknown status uses the fallback color', () => {
  assert.strictEqual(statusColor('ACTIVE'), '#16A34A');
  assert.strictEqual(statusColor('WEIRD', '#FB7185'), '#FB7185');
});

test('attendance: null/empty calendar summarizes to null', () => {
  assert.strictEqual(summarizeAttendance(null), null);
  assert.strictEqual(summarizeAttendance([]), null);
});

test('attendance: counts 7/30-day windows and finds the last visit', () => {
  // server builds the calendar newest-first; index 0 is the reference day
  const history = [
    { date: '2026-03-10', present: false, source: null },
    { date: '2026-03-09', present: true, source: 'QR_CHECK_IN' },
    { date: '2026-03-08', present: true, source: 'FRONT_DESK' },
    { date: '2026-02-20', present: true, source: 'QR_CHECK_IN' }, // 18 days back → 30d only
    { date: '2026-01-15', present: true, source: 'QR_CHECK_IN' }, // 54 days back → neither
  ];
  const s = summarizeAttendance(history, '2026-03-10');
  assert.strictEqual(s.visits7, 2);
  assert.strictEqual(s.visits30, 3);
  assert.strictEqual(s.lastVisit, '2026-03-09');
});

test('attendance: boundary — exactly 7 days back is outside the 7-day window', () => {
  const history = [
    { date: '2026-03-10', present: false, source: null },
    { date: '2026-03-03', present: true, source: 'QR_CHECK_IN' }, // 7 days back
  ];
  const s = summarizeAttendance(history, '2026-03-10');
  assert.strictEqual(s.visits7, 0);
  assert.strictEqual(s.visits30, 1);
  assert.strictEqual(s.lastVisit, '2026-03-03');
});

test('attendance: all-absent calendar still reports zero visits', () => {
  const s = summarizeAttendance([{ date: '2026-03-10', present: false, source: null }], '2026-03-10');
  assert.strictEqual(s.visits7, 0);
  assert.strictEqual(s.visits30, 0);
  assert.strictEqual(s.lastVisit, null);
});
