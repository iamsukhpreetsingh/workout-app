// nutritionDigest.js — trend-based progress (Phase 6/7).
//
// NO daily pass/fail, NO compliance percentages, anywhere. The digest:
//  - averages LOGGED days only — a not-logged day is excluded from the
//    denominator entirely, never treated as a 0-calorie day (which would
//    badly skew the average);
//  - for target_mode='weekly_average' evaluates the trailing 7-day MEAN
//    against the target, so one heavy Saturday and one light Monday feed
//    the same rolling number;
//  - produces plain-language trend lines from simple rules (rolling average
//    within tolerance? is the most recent 3-day sub-trend moving toward or
//    away from target?);
//  - shows logging gaps explicitly ("Not logged: Tue").
const { query } = require('../db/pool');
const coaching = require('./coachingPlans');
const nutritionTargetsService = require('./nutritionTargetsService');
const { getStructureSuggestions } = require('./structureSuggestions');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const dayStr = (d) => d.toISOString().slice(0, 10);

// The trend engine — pure, mirrored in the mobile domain module
// (src/features/diet/domain/nutritionCore.js buildTrendSummary) with tests
// asserting identical language on the same inputs.
function buildTrendSummary(days, target, tolerancePct = 10) {
  const logged = days.filter((d) => d.isLogged);
  const notLoggedDow = days.filter((d) => !d.isLogged).map((d) => d.dow);
  const loggedDays = logged.length;

  const avg = (key) =>
    loggedDays ? logged.reduce((n, d) => n + (Number(d[key]) || 0), 0) / loggedDays : null;
  const avgCalories = avg('calories');
  const avgProtein = avg('protein_g');
  const avgCarbs = avg('carbs_g');
  const avgFat = avg('fat_g');

  // trailing 7-day (here: window) mean — the weekly_average mode's number
  const lower = target.calories ? target.calories * (1 - tolerancePct / 100) : null;
  const upper = target.calories ? target.calories * (1 + tolerancePct / 100) : null;
  const within = (v, t, tol) => t != null && v != null && Math.abs(v - t) <= t * (tol / 100);

  let calorieSummary = null;
  if (target.calories && avgCalories != null) {
    const delta = avgCalories - target.calories;
    // direction: is the most recent 3-day sub-average moving toward or away?
    const last3 = logged.slice(-3);
    const first3 = logged.slice(0, 3);
    const recentDelta = last3.length ? last3.reduce((n, d) => n + d.calories, 0) / last3.length : null;
    const earlyDelta = first3.length && loggedDays > 3 ? first3.reduce((n, d) => n + d.calories, 0) / first3.length : null;
    const movingToward = recentDelta != null && earlyDelta != null ? Math.abs(recentDelta - target.calories) < Math.abs(earlyDelta - target.calories) : true;

    if (within(avgCalories, target.calories, tolerancePct)) {
      calorieSummary = 'right on track';
    } else if (delta < 0) {
      calorieSummary = movingToward ? 'trending up toward target' : 'trending low';
    } else {
      calorieSummary = movingToward ? 'trending down toward target' : 'trending high';
    }
  }

  // macro trend notes — only meaningful, only with targets
  const notes = [];
  if (target.protein_g && avgProtein != null && !within(avgProtein, target.protein_g, 15) && avgProtein < target.protein_g) {
    notes.push('Protein has been trending a little low lately');
  }
  if (target.fat_g && avgFat != null && avgFat > target.fat_g * 1.2) {
    notes.push('Fat has been trending above target lately');
  }

  return {
    loggedDays,
    totalDays: days.length,
    notLoggedDow,
    avgCalories: avgCalories != null ? Math.round(avgCalories) : null,
    avgProtein: avgProtein != null ? Math.round(avgProtein) : null,
    avgCarbs: avgCarbs != null ? Math.round(avgCarbs) : null,
    avgFat: avgFat != null ? Math.round(avgFat) : null,
    withinTolerance: within(avgCalories, target.calories, tolerancePct),
    calorieSummary,
    notes,
  };
}

// Client- and trainer-facing weekly digest over the user-scoped log.
async function getWeeklyDigest(userId, { days = 7 } = {}) {
  const active = await nutritionTargetsService.getActiveNutritionTargets(userId);
  const target = active.active
    ? {
        calories: active.active.calories,
        protein_g: active.active.protein_g,
        carbs_g: active.active.carbs_g,
        fat_g: active.active.fat_g,
        target_source: active.active.target_source,
        set_by: active.active.set_by,
        target_mode: active.active.target_mode,
        tolerance_pct: active.active.tolerance_pct,
      }
    : null;

  const today = new Date();
  const dayRows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const date = dayStr(d);
    dayRows.push({ date, dow: d.toLocaleDateString('en-US', { weekday: 'short' }) });
  }
  const fromDate = dayRows[0].date;
  const { rows: entries } = await query(
    `SELECT log_date, SUM(calories) AS calories, SUM(protein_g) AS protein_g,
            SUM(carbs_g) AS carbs_g, SUM(fat_g) AS fat_g
     FROM food_log_entries
     WHERE user_id = $1 AND log_date >= $2::date
     GROUP BY log_date`,
    [userId, fromDate]
  );
  const byDate = new Map(entries.map((r) => [String(r.log_date).slice(0, 10), r]));
  const trendDays = dayRows.map((d) => {
    const e = byDate.get(d.date);
    return {
      ...d,
      isLogged: !!e,
      calories: e ? Math.round(Number(e.calories) || 0) : 0,
      protein_g: e ? Math.round(Number(e.protein_g) || 0) : 0,
      carbs_g: e ? Math.round(Number(e.carbs_g) || 0) : 0,
      fat_g: e ? Math.round(Number(e.fat_g) || 0) : 0,
    };
  });

  // weekly_average mode: also report the rolling-mean verdict explicitly
  let weeklyAverageVerdict = null;
  if (target && target.target_mode === 'weekly_average' && target.calories) {
    const summary = buildTrendSummary(trendDays, target, target.tolerance_pct);
    weeklyAverageVerdict = summary.withinTolerance ? 'on_track' : summary.avgCalories < target.calories ? 'under' : 'over';
  }

  const summary = target
    ? buildTrendSummary(trendDays, target, target.tolerance_pct || 10)
    : null;
  const suggestions = await getStructureSuggestions(userId).catch(() => []);

  return {
    target,
    profile_complete: active.profile_complete,
    recommendation: active.recommendation,
    recommendation_drift: active.recommendation_drift,
    days: trendDays,
    summary,
    weekly_average_verdict: weeklyAverageVerdict,
    suggestions,
  };
}

// Trainer read: the same digest, association-gated by the route.
async function getTrainerWeeklyDigest(trainerId, clientId, days = 7) {
  await coaching.assertReadableAssociation(trainerId, clientId);
  return getWeeklyDigest(clientId, { days });
}

// Trainer read-only day-by-day browse of the client's ACTUAL log (Phase 7).
async function getClientFoodLogForTrainer(trainerId, clientId, from, to) {
  await coaching.assertReadableAssociation(trainerId, clientId);
  const { rows } = await query(
    `SELECT * FROM food_log_entries
     WHERE user_id = $1
       AND ($2::date IS NULL OR log_date >= $2::date)
       AND ($3::date IS NULL OR log_date <= $3::date)
     ORDER BY log_date DESC, logged_at ASC LIMIT 500`,
    [clientId, from || null, to || null]
  );
  return rows;
}

module.exports = { buildTrendSummary, getWeeklyDigest, getTrainerWeeklyDigest, getClientFoodLogForTrainer };
