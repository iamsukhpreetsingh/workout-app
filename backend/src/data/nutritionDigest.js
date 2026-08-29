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
const todayStr = () => dayStr(new Date());

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

// ── trainer day / week / month monitoring (spec §1–13, §21–23) ───────────

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const STATUS_OF = (actual, target, tol) => {
  if (!target) return null;
  if (actual * 100 < target * (100 - tol)) return 'under_target';
  if (actual * 100 > target * (100 + tol)) return 'over_target';
  return 'on_target';
};

// The target VERSION effective on a date — historical days always evaluate
// against the version in force on THEIR date (§24 Rule 12).
async function resolveTargetForDate(userId, dateStr) {
  const { rows } = await query(
    `SELECT * FROM user_nutrition_targets
     WHERE user_id = $1 AND effective_from <= $2::date
     ORDER BY effective_from DESC, version_number DESC LIMIT 1`,
    [userId, String(dateStr).slice(0, 10)]
  );
  const v = rows[0];
  return v
    ? {
        calories: v.calories,
        protein_g: Number(v.protein_g),
        carbs_g: Number(v.carbs_g),
        fat_g: Number(v.fat_g),
        tolerance_pct: v.tolerance_pct ?? 10,
        target_source: v.target_source,
        target_mode: v.target_mode || 'daily',
      }
    : null;
}

// ONE day, full detail: status headline (Target Hit / Under / Over / Not
// Logged — "not logged" is NEVER "under target"), per-macro independent
// status against the tolerance, remaining/excess, grouped read-only log.
async function getClientDailyNutrition(userId, dateStr) {
  const date = String(dateStr).slice(0, 10);
  const [target, entryRows] = await Promise.all([
    resolveTargetForDate(userId, date),
    query(
      `SELECT * FROM food_log_entries WHERE user_id = $1 AND log_date = $2::date ORDER BY logged_at ASC`,
      [userId, date]
    ).then((r) => r.rows),
  ]);
  const tol = target?.tolerance_pct ?? 10;
  const sum = (k) => entryRows.reduce((n, e) => n + (Number(e[k]) || 0), 0);
  const totals = {
    calories: Math.round(sum('calories')),
    protein_g: Math.round(sum('protein_g')),
    carbs_g: Math.round(sum('carbs_g')),
    fat_g: Math.round(sum('fat_g')),
  };
  const isLogged = entryRows.length > 0;
  const macroBlock = (actual, t) => ({
    actual, target: t || null,
    status: isLogged && t ? STATUS_OF(actual, t, tol) : null,
    remaining: t ? Math.max(0, t - actual) : null,
    over: t ? Math.max(0, actual - t) : null,
  });
  const groups = new Map();
  for (const e of entryRows) {
    const mt = MEAL_ORDER.includes(e.meal_type) ? e.meal_type : 'other';
    if (!groups.has(mt)) groups.set(mt, []);
    groups.get(mt).push({
      id: e.id, name: e.name, calories: e.calories != null ? Math.round(e.calories) : null,
      quantity: e.quantity, serving_unit: e.serving_unit, food_source_type: e.food_source_type,
    });
  }
  return {
    date,
    is_future: date > todayStr(),
    target,
    isLogged,
    totals,
    calorieStatus: !isLogged ? 'not_logged' : target?.calories ? STATUS_OF(totals.calories, target.calories, tol) : null,
    remaining: target?.calories ? Math.max(0, target.calories - totals.calories) : null,
    over: target?.calories ? Math.max(0, totals.calories - target.calories) : null,
    macros: target
      ? {
          protein_g: macroBlock(totals.protein_g, target.protein_g),
          carbs_g: macroBlock(totals.carbs_g, target.carbs_g),
          fat_g: macroBlock(totals.fat_g, target.fat_g),
        }
      : null,
    foodLog: MEAL_ORDER.filter((mt) => groups.has(mt)).map((mt) => ({
      meal_type: mt,
      kcal: groups.get(mt).reduce((n, e) => n + (e.calories || 0), 0),
      entries: groups.get(mt),
    })),
  };
}

// Week / Month history (§8–13): one aggregated query over the date range —
// never the client's lifetime history. Averages come from LOGGED days only
// (§12); not-logged days are never counted as under-target (§10).
async function getClientNutritionHistory(userId, { mode = 'week', date } = {}) {
  const anchor = String(date || todayStr()).slice(0, 10);
  let fromDate, toDate;
  if (mode === 'month') {
    fromDate = anchor.slice(0, 8) + '01';
    const d = new Date(`${fromDate}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    toDate = dayStr(d);
  } else {
    // week = the 7 days ending at the anchor date
    toDate = anchor;
    const d = new Date(`${anchor}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6);
    fromDate = dayStr(d);
  }
  const [target, { rows: agg }] = await Promise.all([
    resolveTargetForDate(userId, anchor),
    query(
      `SELECT log_date,
              SUM(calories) AS calories, SUM(protein_g) AS protein_g,
              SUM(carbs_g) AS carbs_g, SUM(fat_g) AS fat_g
       FROM food_log_entries
       WHERE user_id = $1 AND log_date >= $2::date AND log_date <= $3::date
       GROUP BY log_date`,
      [userId, fromDate, toDate]
    ),
  ]);
  const tol = target?.tolerance_pct ?? 10;
  const byDate = new Map(agg.map((r) => [String(r.log_date).slice(0, 10), r]));
  const days = [];
  const cur = new Date(`${fromDate}T12:00:00Z`);
  while (dayStr(cur) <= toDate) {
    const ds = dayStr(cur);
    const e = byDate.get(ds);
    const calories = e ? Math.round(Number(e.calories) || 0) : 0;
    days.push({
      date: ds,
      dow: new Date(`${ds}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      isLogged: !!e,
      calories,
      protein_g: e ? Math.round(Number(e.protein_g) || 0) : 0,
      carbs_g: e ? Math.round(Number(e.carbs_g) || 0) : 0,
      fat_g: e ? Math.round(Number(e.fat_g) || 0) : 0,
      status: !e ? 'not_logged' : target?.calories ? STATUS_OF(calories, target.calories, tol) : null,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return summarizeHistory(days, target, { mode, fromDate, toDate });
}

// Pure summarization over per-day rows — unit-testable without a database.
function summarizeHistory(days, target, { mode, fromDate, toDate } = {}) {
  const logged = days.filter((d) => d.isLogged);
  const avg = (k) =>
    logged.length ? Math.round(logged.reduce((n, d) => n + (Number(d[k]) || 0), 0) / logged.length) : null;
  const onTarget = logged.filter((d) => d.status === 'on_target').length;
  const under = logged.filter((d) => d.status === 'under_target').length;
  const over = logged.filter((d) => d.status === 'over_target').length;
  return {
    mode,
    from_date: fromDate,
    to_date: toDate,
    total_days: days.length,
    days_logged: logged.length,
    days_on_target: onTarget,
    days_under: under,
    days_over: over,
    averages: target
      ? {
          calories: avg('calories'),
          calories_target: target.calories,
          protein_g: avg('protein_g'),
          protein_target: target.protein_g,
          carbs_g: avg('carbs_g'),
          carbs_target: target.carbs_g,
          fat_g: avg('fat_g'),
          fat_target: target.fat_g,
        }
      : { calories: avg('calories'), protein_g: avg('protein_g'), carbs_g: avg('carbs_g'), fat_g: avg('fat_g') },
    achievement_pct: logged.length ? Math.round((onTarget / logged.length) * 100) : null,
    days,
  };
}

// ── missed-target notifications (§14–18) ─────────────────────────────────

async function getNutritionPrefs(trainerId, clientId) {
  const { rows } = await query(
    `SELECT * FROM trainer_nutrition_prefs WHERE trainer_id = $1 AND client_id = $2`,
    [trainerId, clientId]
  );
  return rows[0] || { trainer_id: trainerId, client_id: clientId, target_miss_notifications: false };
}

async function setNutritionPrefs(trainerId, clientId, { target_miss_notifications }) {
  await coaching.assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `INSERT INTO trainer_nutrition_prefs (trainer_id, client_id, target_miss_notifications)
     VALUES ($1,$2,$3)
     ON CONFLICT (trainer_id, client_id) DO UPDATE SET
       target_miss_notifications = EXCLUDED.target_miss_notifications, updated_at = now()
     RETURNING *`,
    [trainerId, clientId, target_miss_notifications === true]
  );
  return rows[0];
}

// Evaluate COMPLETED days (past only — today is still happening) and create
// ONE notification per (trainer, client, date, direction), gated on the
// relationship's preference. Editing a historical day re-evaluates the
// status but never duplicates alerts: the UNIQUE ledger absorbs every
// subsequent sync of the same day, and a day corrected to on-target sends
// nothing new (§17). on_target days — even with 0/4 plan meals followed —
// never notify (§15).
// Pure: which (if any) notification direction a day's status produces.
// on_target — even with 0/4 plan meals followed — never notifies; a day
// with no food logged never notifies (§15, §28).
function missDirection(calorieStatus) {
  if (calorieStatus === 'under_target') return 'under';
  if (calorieStatus === 'over_target') return 'over';
  return null;
}

async function evaluateMissedTargetNotifications(userId, dates) {
  const { rows: trainers } = await query(
    `SELECT tc.trainer_id, COALESCE(p.target_miss_notifications, false) AS enabled
     FROM trainer_clients tc
     LEFT JOIN trainer_nutrition_prefs p ON p.trainer_id = tc.trainer_id AND p.client_id = tc.client_id
     WHERE tc.client_id = $1 AND tc.status = 'active'`,
    [userId]
  );
  for (const t of trainers) {
    if (!t.enabled) continue;
    for (const rawDate of Array.isArray(dates) ? dates : [dates]) {
      const date = String(rawDate).slice(0, 10);
      if (date >= todayStr()) continue;
      const day = await getClientDailyNutrition(userId, date);
      if (!day.isLogged || !day.target?.calories) continue;
      const direction = missDirection(day.calorieStatus);
      if (!direction) continue;
      // idempotent ledger — ON CONFLICT DO NOTHING is the dedup guarantee
      const { rowCount } = await query(
        `INSERT INTO diet_target_notifications (trainer_id, client_id, log_date, direction)
         VALUES ($1,$2,$3,$4) ON CONFLICT (trainer_id, client_id, log_date, direction) DO NOTHING`,
        [t.trainer_id, userId, date, direction]
      );
      if (!rowCount) continue;
      const { rows: clientRows } = await query('SELECT name FROM users WHERE id = $1', [userId]);
      const clientName = clientRows[0]?.name || 'Your client';
      const { createNotification } = require('./notifications');
      await createNotification({
        recipientId: t.trainer_id,
        actorId: userId,
        type: 'nutrition_target_missed',
        title: 'Nutrition Target Missed',
        body:
          direction === 'under'
            ? `${clientName} was below their calorie target on ${date}. Target: ${day.target.calories} kcal, actual: ${day.totals.calories} kcal (${day.remaining} kcal below).`
            : `${clientName} exceeded their calorie target on ${date}. Target: ${day.target.calories} kcal, actual: ${day.totals.calories} kcal (${day.over} kcal over).`,
        relatedClientId: userId,
      }).catch(() => {});
    }
  }
}

module.exports = {
  buildTrendSummary, getWeeklyDigest, getTrainerWeeklyDigest, getClientFoodLogForTrainer,
  resolveTargetForDate, getClientDailyNutrition, getClientNutritionHistory, summarizeHistory,
  missDirection, getNutritionPrefs, setNutritionPrefs, evaluateMissedTargetNotifications,
};
