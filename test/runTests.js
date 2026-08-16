// Plain-Node unit tests for the pure logic (no React Native required).
// Run: npm test
import assert from 'node:assert';
import { plateBreakdown } from '../src/lib/plates.js';
import { e1rm, avgRpe, rpeInsight } from '../src/lib/stats.js';

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

console.log(`\n${passed} tests passed`);
