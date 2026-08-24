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

console.log(`\n${passed} tests passed`);
