// Hand-computed acceptance tests for the 4 built-in formulas (System 1
// acceptance criteria). Run from the PROJECT ROOT with Node 20.10+:
//   node --experimental-default-type=module src/progressionFormulas/selftest.mjs
// (If your Node is older, skip this file — the same cases are verified
// in-app during Phase B testing.)
import linear from './linearProgression.js';
import double from './doubleProgression.js';
import rpe from './rpeAutoregulated.js';
import percentage from './percentageBased.js';

const cases = [];
const t = (name, cond, got) => cases.push([cond ? 'PASS' : 'FAIL', name, got]);
const S = (weight, reps, targetReps, extra = {}) =>
  ({ weight, reps, targetReps, completed: true, rpe: null, sessionIndex: 0, ...extra });

// ── Linear Progression (reps-before-weight: <10 reps → same weight +1 rep;
//    ≥10 reps → add weight) ──
let r = linear.calculate([S(60,8,8), S(60,8,8), S(60,8,8)], { incrementKg: 2.5 });
t('Linear: 8 reps < threshold → repeat 60×9', r.suggestedWeight === 60 && r.suggestedReps === 9, r);
r = linear.calculate([S(60,10,10), S(60,10,10)], { incrementKg: 2.5 });
t('Linear: 10 reps hit → 62.5×10', r.suggestedWeight === 62.5 && r.suggestedReps === 10, r);
t('Linear: empty history → null', linear.calculate([], {}) === null, null);

// ── Double Progression (8–12, +2.5kg) ──
r = double.calculate([S(60,12,12), S(60,12,12)], {});
t('Double: all at top → 62.5×8', r.suggestedWeight === 62.5 && r.suggestedReps === 8, r);
r = double.calculate([S(60,10,10), S(60,9,10)], {});
t('Double: mid-range → 60×(weakest 9 +1 = 10)', r.suggestedWeight === 60 && r.suggestedReps === 10, r);
t('Double: empty history → null', double.calculate([], {}) === null, null);

// ── RPE-Autoregulated ──
r = rpe.calculate([S(60,8,8,{rpe:7}), S(60,8,8,{rpe:7}), S(60,8,8,{rpe:8})], {});
t('RPE: avg 7.33 < 7.5 → 62.5', r.suggestedWeight === 62.5, r);
r = rpe.calculate([S(60,8,8,{rpe:9}), S(60,8,8,{rpe:9.5})], {});
t('RPE: avg 9.25 ≥ 9 → 57.5', r.suggestedWeight === 57.5, r);
r = rpe.calculate([S(60,8,8), S(60,8,8)], { incrementKg: 2.5 });
t('RPE: no RPE logged → linear fallback 60×9', r.suggestedWeight === 60 && r.suggestedReps === 9, r);
r = rpe.calculate([S(60,8,8,{rpe:8})], {});
t('RPE: avg 8 → hold 60', r.suggestedWeight === 60, r);

// ── Percentage-Based (max 100kg, 70/80/90) ──
const wk = (n) => Date.now() - n * 86400000;
r = percentage.calculate([S(0,5,5,{ trainingMax: 100, performedAt: wk(0) })], {});
t('Pct: 1 distinct week → 70×5', r.suggestedWeight === 70 && r.suggestedReps === 5, r);
r = percentage.calculate(
  [S(0,5,5,{ trainingMax: 100, performedAt: wk(0) }), S(0,5,5,{ trainingMax: 100, performedAt: wk(8) })], {});
t('Pct: 2 distinct weeks → 80×5', r.suggestedWeight === 80 && r.suggestedReps === 5, r);
r = percentage.calculate([S(60,5,5,{ performedAt: wk(0) })], {});
t('Pct: no training max → null', r === null, r);

let fail = 0;
for (const [st, name, got] of cases) {
  console.log(st + '  ' + name + (st === 'FAIL' ? '  → ' + JSON.stringify(got) : ''));
  if (st === 'FAIL') fail++;
}
console.log(fail ? `\n${fail} FAILED` : '\nAll formula tests passed');