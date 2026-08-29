// Backend tests for the nutrition target calculator (CommonJS mirror of
// src/features/diet/domain/nutritionTargets.js) — the target service's
// authoritative math. The mobile mirror is covered by test/runTests.js with
// the SAME scenarios; both must stay behaviorally identical.
const test = require('node:test');
const assert = require('node:assert');
const calc = require('../src/data/nutritionTargetsCalc');

test('recommendation: Mifflin-St Jeor + activity + deficit (documented example)', () => {
  const r = calc.calculateRecommendation({
    age: 27, gender: 'male', height_cm: 178, weight_kg: 82,
    activity_level: 'moderate', primary_goal: 'weight_loss', goal_intensity: 'standard',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.recommendation.calories, 2240);
  assert.strictEqual(r.recommendation.protein_g, 164);
  assert.strictEqual(r.details.tdee, 2794);
});

test('recommendation: incomplete profile is refused, not guessed', () => {
  const r = calc.calculateRecommendation({ age: 27 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('weight_kg'));
  assert.strictEqual(r.recommendation, null);
});

test('recommendation: calorie floor holds for small sedentary females', () => {
  const r = calc.calculateRecommendation({
    age: 60, gender: 'female', height_cm: 150, weight_kg: 55,
    activity_level: 'sedentary', primary_goal: 'weight_loss', goal_intensity: 'aggressive',
  });
  assert.ok(r.recommendation.calories >= 1200);
});

test('provided-fields validation: partial saves pass, invalid values fail', () => {
  assert.strictEqual(calc.validateProvidedNutritionFields({}).ok, true);
  assert.strictEqual(calc.validateProvidedNutritionFields({ age: 200 }).ok, false);
  assert.strictEqual(calc.validateProvidedNutritionFields({ activity_level: 'extreme' }).ok, true);
});

test('recommendation-inputs comparison drives target versioning decisions', () => {
  assert.strictEqual(calc.recommendationInputsChanged({ weight_kg: '82' }, { weight_kg: 82 }), false);
  assert.strictEqual(calc.recommendationInputsChanged({ weight_kg: 82 }, { weight_kg: 79 }), true);
  assert.strictEqual(calc.recommendationInputsChanged({}, {}), false);
});
