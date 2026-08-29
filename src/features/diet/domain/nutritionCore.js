// nutritionCore.js — THE single authoritative calculation module for the
// outcome-first nutrition model:
//
//   plan = recommendation · food diary = reality · nutrition target = outcome
//
// Pure functions only — NO React Native / SQLite / fetch imports. This module
// runs under plain Node so test/runTests.js can regression-test the target
// status boundaries, plan follow-through, contextual insights, weekly
// summary, and trainer monitoring exceptions directly.
//
// A mirrored CommonJS copy lives at backend/src/data/nutritionCore.js so the
// server-side monitoring service uses the identical algorithm. The two MUST
// stay behaviorally identical — both are covered by test suites that assert
// the same scenarios (tolerance boundaries, follow-through, monitoring).
//
// Key invariants (do not weaken):
//  - Calories are the headline; each macro is evaluated independently. A
//    macro miss never turns an on-target day into a failed day.
//  - `not_logged` is its own state — a day with no entries is NEVER 0/X
//    "under target" and NEVER "0% adherence".
//  - Tolerance boundaries are inclusive: actual == lower bound and
//    actual == upper bound are both `on_target`. Comparisons are done by
//    cross-multiplied integers (actual*100 vs target*(100±tol)) so the
//    documented boundary values (2400 ± 10% → 2160 / 2640) compare exactly,
//    with no floating-point division on the boundary.
//  - Plan follow-through NEVER determines the day's verdict.
//  - Today (an unfinished day) shows progress (`in_progress`), never a
//    final under-target failure.

export const STATUS = {
  ON_TARGET: 'on_target',
  UNDER_TARGET: 'under_target',
  OVER_TARGET: 'over_target',
  NOT_LOGGED: 'not_logged',
  IN_PROGRESS: 'in_progress',
};

export const DEFAULT_TOLERANCE_PCT = 10;

// Human-facing metadata for a status. UI maps colorKey → palette color.
export const STATUS_META = {
  [STATUS.ON_TARGET]: { label: 'On target', symbol: '✓', direction: 'checkmark-circle', colorKey: 'green' },
  [STATUS.UNDER_TARGET]: { label: 'Under target', symbol: '↓', direction: 'arrow-down', colorKey: 'orange' },
  [STATUS.OVER_TARGET]: { label: 'Over target', symbol: '↑', direction: 'arrow-up', colorKey: 'red' },
  [STATUS.NOT_LOGGED]: { label: 'Not logged', symbol: '—', direction: 'remove', colorKey: 'textDim' },
  [STATUS.IN_PROGRESS]: { label: 'Today', symbol: '', direction: 'time', colorKey: 'blue' },
};

// ── target status ─────────────────────────────────────────────────────────

// Inclusive tolerance bounds, cross-multiplied form. Returns null when no
// target is configured (macro without a target is simply not evaluated).
export function toleranceBounds(target, tolerancePct = DEFAULT_TOLERANCE_PCT) {
  const t = Number(target);
  if (t == null || !isFinite(t) || t <= 0) return null;
  const tol = Number(tolerancePct ?? DEFAULT_TOLERANCE_PCT);
  const pct = isFinite(tol) && tol >= 0 ? tol : DEFAULT_TOLERANCE_PCT;
  // Keep the arithmetic in scaled integers: actual*100 vs target*(100±pct)
  // — see evaluateAgainstTarget below.
  return {
    lower: (t * (100 - pct)) / 100,
    upper: (t * (100 + pct)) / 100,
    _lowerScaled: t * (100 - pct),
    _upperScaled: t * (100 + pct),
  };
}

// 'under_target' | 'on_target' | 'over_target' | null (no target configured).
export function evaluateAgainstTarget(actual, target, tolerancePct = DEFAULT_TOLERANCE_PCT) {
  const a = Number(actual) || 0;
  const t = Number(target);
  if (t == null || !isFinite(t) || t <= 0) return null;
  const tol = Number(tolerancePct ?? DEFAULT_TOLERANCE_PCT);
  const pct = isFinite(tol) && tol >= 0 ? tol : DEFAULT_TOLERANCE_PCT;
  // Cross-multiplication avoids dividing the boundary values: with
  // target=2400 / tol=10 the bounds are exactly 216000 and 264000 scaled,
  // so actual=2160 and actual=2640 land inside and 2159 / 2641 outside.
  const scaled = a * 100;
  if (scaled < t * (100 - pct)) return STATUS.UNDER_TARGET;
  if (scaled > t * (100 + pct)) return STATUS.OVER_TARGET;
  return STATUS.ON_TARGET;
}

// Per-nutrient evaluation block used for calories AND every configured macro.
function nutrientBlock(actual, target, tolerancePct) {
  const status = evaluateAgainstTarget(actual, target, tolerancePct);
  return {
    actual: Math.round(actual),
    target: target != null && isFinite(Number(target)) && Number(target) > 0 ? Math.round(Number(target)) : null,
    remaining: target != null && Number(target) > 0 ? Math.max(0, Math.round(Number(target) - actual)) : null,
    over: target != null && Number(target) > 0 ? Math.max(0, Math.round(actual - Number(target))) : 0,
    status,
  };
}

// ── plan follow-through ───────────────────────────────────────────────────

const normName = (s) => String(s || '').trim().toLowerCase();

// completed = planned items the diary shows were eaten as planned (source
// 'planned'/'swapped' with the item ref, or any entry matching the item's
// name — eating the planned food counts as following regardless of which
// button it was logged through). total = planned items for that day.
// Extra and free-logged foods NEVER reduce the value. total === 0 → null
// (the UI omits the section; never render "0 / 0").
export function computePlanFollowThrough(plannedItems, entries) {
  const items = Array.isArray(plannedItems) ? plannedItems : [];
  const total = items.length;
  if (total === 0) return null;
  const plannedNames = new Set(items.map((i) => normName(i?.name)));
  const refs = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((e) => e.source === 'planned' || e.source === 'swapped')
      .map((e) => String(e.planned_item_ref ?? ''))
      .filter(Boolean)
  );
  const loggedNames = new Set(
    (Array.isArray(entries) ? entries : []).map((e) => normName(e?.name)).filter(Boolean)
  );
  let completed = 0;
  for (const item of items) {
    if (refs.has(String(item?.id ?? '')) || (plannedNames.size && loggedNames.has(normName(item?.name)))) {
      completed += 1;
    }
  }
  return { completed, total };
}

// ── daily summary ─────────────────────────────────────────────────────────

function macroMissRatioInsight(followThrough) {
  if (!followThrough || !followThrough.total) return 0;
  return followThrough.completed / followThrough.total;
}

// entries: raw diary rows for the date (any/all sources).
// targets: { calories, protein_g, carbs_g, fat_g } — any entry may be null.
// options.isToday: the day is not over — under-target shows as in_progress.
export function computeDailySummary({ date, entries, targets = {}, tolerancePct, isToday = false, planFollowThrough = null }) {
  const list = Array.isArray(entries) ? entries : [];
  const sum = (key) => list.reduce((n, e) => n + (Number(e?.[key]) || 0), 0);
  const cal = sum('calories');
  const pro = sum('protein_g');
  const car = sum('carbs_g');
  const fat = sum('fat_g');

  const followThrough = planFollowThrough !== null ? planFollowThrough : computePlanFollowThrough([], list);

  if (list.length === 0) {
    return {
      date,
      isLogged: false,
      isToday: !!isToday,
      calories: nutrientBlock(0, targets.calories, tolerancePct),
      macros: {
        protein: nutrientBlock(0, targets.protein_g, tolerancePct),
        carbs: nutrientBlock(0, targets.carbs_g, tolerancePct),
        fat: nutrientBlock(0, targets.fat_g, tolerancePct),
      },
      targetStatus: STATUS.NOT_LOGGED,
      planFollowThrough: followThrough,
      contextualInsight: null,
    };
  }

  const calStatus = evaluateAgainstTarget(cal, targets.calories, tolerancePct);
  // A live day is never given its final failing verdict (§40): only a
  // completed day can be under/over. Over-target is shown as soon as it
  // happens — the user can still act on it today.
  const headline =
    isToday && calStatus === STATUS.UNDER_TARGET ? STATUS.IN_PROGRESS : calStatus;

  const proteinBlock = nutrientBlock(pro, targets.protein_g, tolerancePct);
  const carbsBlock = nutrientBlock(car, targets.carbs_g, tolerancePct);
  const fatBlock = nutrientBlock(fat, targets.fat_g, tolerancePct);

  const hitTarget = calStatus === STATUS.ON_TARGET;
  const ratio = macroMissRatioInsight(followThrough);
  let contextualInsight = null;
  if (hitTarget && followThrough && ratio < 0.5) {
    contextualInsight = 'You reached your targets with different foods today.';
  } else if (!hitTarget && calStatus !== null && followThrough && ratio >= 0.8) {
    contextualInsight = 'You followed the planned meals, but the day’s nutrition target was missed.';
  }

  return {
    date,
    isLogged: true,
    isToday: !!isToday,
    calories: nutrientBlock(cal, targets.calories, tolerancePct),
    macros: { protein: proteinBlock, carbs: carbsBlock, fat: fatBlock },
    targetStatus: headline,
    planFollowThrough: followThrough,
    contextualInsight,
  };
}

// ── recent foods + quantity memory ────────────────────────────────────────

// Group diary history by food name; keep the most recent entry per name
// (including its quantity — quantity memory belongs to the user's usage,
// never to the catalog food itself).
export function buildRecentFoods(allEntries, limit = 8) {
  const byName = new Map();
  for (const e of Array.isArray(allEntries) ? allEntries : []) {
    if (!e?.name) continue;
    const key = normName(e.name);
    const prev = byName.get(key);
    if (!prev || (e.logged_at || 0) > (prev.logged_at || 0)) byName.set(key, { ...e, name: e.name });
  }
  return [...byName.values()]
    .sort((a, b) => (b.logged_at || 0) - (a.logged_at || 0))
    .slice(0, limit);
}

// ── "Find food to fit" — deterministic V1 matcher (no AI) ─────────────────

// remaining: { calories, protein_g } (null-safe). candidates: foods with
// calories (+protein_g where known) — recents, recipes, plan items.
// Ranks by how well the item's calories fit the remaining budget, with a
// nudge toward protein-dense foods when protein remains.
export function suggestFoodsToFit(remaining, candidates, limit = 5) {
  const calRemaining = Number(remaining?.calories);
  if (!isFinite(calRemaining) || calRemaining <= 0) return [];
  const proRemaining = Number(remaining?.protein_g) || 0;
  const scored = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const cal = Number(c?.calories);
    if (!isFinite(cal) || cal <= 0) continue;
    if (cal > calRemaining * 1.15) continue; // would clearly blow the budget
    const fitPenalty = Math.abs(cal - calRemaining);
    const protein = Number(c?.protein_g) || 0;
    const score = fitPenalty - (proRemaining > 0 ? protein * 2 : 0);
    scored.push({ candidate: c, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.candidate);
}

// ── history / weekly summary ──────────────────────────────────────────────

// daySummaries: computeDailySummary outputs, oldest → newest, exactly one
// per day of the week (not-logged days included).
export function computeWeeklySummary(daySummaries) {
  const days = Array.isArray(daySummaries) ? daySummaries : [];
  const logged = days.filter((d) => d.isLogged);
  const onTarget = days.filter((d) => d.targetStatus === STATUS.ON_TARGET).length;
  const under = days.filter((d) => d.targetStatus === STATUS.UNDER_TARGET).length;
  const over = days.filter((d) => d.targetStatus === STATUS.OVER_TARGET).length;
  const inProgress = days.filter((d) => d.targetStatus === STATUS.IN_PROGRESS).length;
  const completedDays = days.filter((d) => d.isLogged && d.targetStatus !== STATUS.IN_PROGRESS);
  const planFollowedDays = days.filter((d) => {
    const ft = d.planFollowThrough;
    return ft && ft.total > 0 && ft.completed / ft.total >= 0.8;
  }).length;
  // Target hits on days the plan wasn't really followed — the successful
  // flexibility signal (§29), surfaced in the weekly insight.
  const hitOnDifferentFoods = days.filter((d) => {
    const ft = d.planFollowThrough;
    return d.targetStatus === STATUS.ON_TARGET && ft && ft.total > 0 && ft.completed / ft.total < 0.5;
  }).length;

  const avgActual = logged.length
    ? Math.round(logged.reduce((n, d) => n + (d.calories.actual || 0), 0) / logged.length)
    : null;
  const withTarget = logged.filter((d) => d.calories.target);
  const avgTarget = withTarget.length
    ? Math.round(withTarget.reduce((n, d) => n + d.calories.target, 0) / withTarget.length)
    : null;

  let insight = null;
  const tracked = logged.length;
  if (tracked > 0) {
    const onTargetCompleted = completedDays.filter((d) => d.targetStatus === STATUS.ON_TARGET).length;
    insight =
      `You hit your calorie target on ${onTargetCompleted} of ${completedDays.length || tracked} tracked days.`;
    if (hitOnDifferentFoods > 0) {
      insight += ` You also hit your targets on ${hitOnDifferentFoods} ${hitOnDifferentFoods === 1 ? 'day' : 'days'} when you didn't follow the planned meals.`;
    }
  }

  return {
    days: days.length,
    tracked,
    onTarget,
    under,
    over,
    inProgress,
    notLogged: days.length - tracked,
    planFollowedDays,
    hitOnDifferentFoods,
    avgCalories: avgActual,
    avgCaloriesTarget: avgTarget,
    insight,
  };
}

// ── trend-based progress (log-first model) ────────────────────────────────

// Plain-language weekly trend (Phase 6/7). days: [{ dow, isLogged, calories,
// protein_g, carbs_g, fat_g }] oldest → newest. NOT-LOGGED DAYS ARE EXCLUDED
// from every average — never treated as a 0-calorie day. No pass/fail
// language anywhere: 'right on track' / 'trending low' / 'trending high' /
// 'trending up toward target' / 'trending down toward target', computed
// from the rolling average + whether the most recent 3 logged days are
// moving toward or away from target. MIRRORED in
// backend/src/data/nutritionDigest.js (buildTrendSummary) — tests in both
// packages assert identical language on identical inputs.
export function buildTrendSummary(days, target, tolerancePct = 10) {
  const list = Array.isArray(days) ? days : [];
  const logged = list.filter((d) => d.isLogged);
  const notLoggedDow = list.filter((d) => !d.isLogged).map((d) => d.dow);
  const loggedDays = logged.length;

  const avg = (key) =>
    loggedDays ? logged.reduce((n, d) => n + (Number(d[key]) || 0), 0) / loggedDays : null;
  const avgCalories = avg('calories');
  const avgProtein = avg('protein_g');
  const avgCarbs = avg('carbs_g');
  const avgFat = avg('fat_g');

  const within = (v, t, tol) =>
    t != null && v != null && Math.abs(v - t) <= t * (tol / 100);

  let calorieSummary = null;
  if (target?.calories && avgCalories != null) {
    const delta = avgCalories - target.calories;
    const last3 = logged.slice(-3);
    const first3 = logged.slice(0, 3);
    const recentDelta = last3.length ? last3.reduce((n, d) => n + d.calories, 0) / last3.length : null;
    const earlyDelta =
      first3.length && loggedDays > 3 ? first3.reduce((n, d) => n + d.calories, 0) / first3.length : null;
    const movingToward =
      recentDelta != null && earlyDelta != null
        ? Math.abs(recentDelta - target.calories) < Math.abs(earlyDelta - target.calories)
        : true;
    if (within(avgCalories, target.calories, tolerancePct)) calorieSummary = 'right on track';
    else if (delta < 0) calorieSummary = movingToward ? 'trending up toward target' : 'trending low';
    else calorieSummary = movingToward ? 'trending down toward target' : 'trending high';
  }

  const notes = [];
  if (target?.protein_g && avgProtein != null && !within(avgProtein, target.protein_g, 15) && avgProtein < target.protein_g) {
    notes.push('Protein has been trending a little low lately');
  }
  if (target?.fat_g && avgFat != null && avgFat > target.fat_g * 1.2) {
    notes.push('Fat has been trending above target lately');
  }

  return {
    loggedDays,
    totalDays: list.length,
    notLoggedDow,
    avgCalories: avgCalories != null ? Math.round(avgCalories) : null,
    avgProtein: avgProtein != null ? Math.round(avgProtein) : null,
    avgCarbs: avgCarbs != null ? Math.round(avgCarbs) : null,
    avgFat: avgFat != null ? Math.round(avgFat) : null,
    withinTolerance: within(avgCalories, target?.calories, tolerancePct),
    calorieSummary,
    notes,
  };
}

// dayOutcomes: ordered oldest → newest over the monitoring window, one entry
// per calendar day:
//   { date, status, planFollowedRatio }  — status is one of STATUS.* for
//   detailed days, or 'simple_followed' / 'simple_missed' for Simple-mode
//   check-in days. macroMisses: { protein: bool, carbs: bool, fat: bool }
//   on logged days (only macros that actually have targets).
// Returns metrics + prioritized alerts. NO per-deviation noise.
export function evaluateClientMonitoring(dayOutcomes) {
  const days = Array.isArray(dayOutcomes) ? dayOutcomes : [];
  const isLoggedDay = (d) => d.status !== STATUS.NOT_LOGGED;
  const tracked = days.filter(isLoggedDay);
  const daysTracked = tracked.length;
  const daysOnTarget = tracked.filter((d) => d.status === STATUS.ON_TARGET || d.status === 'simple_followed').length;
  const daysUnder = tracked.filter((d) => d.status === STATUS.UNDER_TARGET || d.status === 'simple_missed').length;
  const daysOver = tracked.filter((d) => d.status === STATUS.OVER_TARGET).length;
  const planFollowedDays = days.filter((d) => d.planFollowedRatio != null && d.planFollowedRatio >= 0.8).length;
  const targetMissedDays = daysUnder + daysOver;

  // trailing not-logged streak over the window (a streak of "nothing logged")
  let missingLoggingStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].status === STATUS.NOT_LOGGED) missingLoggingStreak += 1;
    else break;
  }

  // trailing consecutive under/over streaks among LOGGED days — a not-logged
  // day neither extends nor breaks the streak (it isn't evidence either way)
  const trailingStreak = (status) => {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].status === STATUS.NOT_LOGGED) continue;
      if (days[i].status === status) streak += 1;
      else break;
    }
    return streak;
  };
  const repeatedUnderTarget = trailingStreak(STATUS.UNDER_TARGET);
  const repeatedOverTarget = trailingStreak(STATUS.OVER_TARGET);

  const alerts = [];
  if (missingLoggingStreak >= 2) {
    alerts.push({
      level: 'high',
      key: 'missing_logging',
      message: `No food logged for ${missingLoggingStreak} days.`,
    });
  }
  if (repeatedUnderTarget >= 3) {
    alerts.push({
      level: 'high',
      key: 'repeated_under',
      message: `Client has been under calorie target for ${repeatedUnderTarget} days.`,
    });
  }
  if (repeatedOverTarget >= 3) {
    alerts.push({
      level: 'high',
      key: 'repeated_over',
      message: `Client has exceeded calorie target for ${repeatedOverTarget} days.`,
    });
  }

  // Plan may need review: the plan was followed but targets still missed —
  // a plan problem, NOT client non-compliance (§28).
  let potentialPlanIssue = false;
  if (daysTracked >= 3 && planFollowedDays / daysTracked >= 0.8 && targetMissedDays >= 3) {
    potentialPlanIssue = true;
    alerts.push({
      level: 'high',
      key: 'plan_review',
      message: 'Plan may need review — targets were missed even on days the plan was followed.',
    });
  }

  // Successful flexibility: targets hit without following the plan —
  // informational, NEVER a negative flag (§29).
  let successfulFlexibility = false;
  if (daysTracked >= 3 && planFollowedDays / daysTracked < 0.5 && daysOnTarget / daysTracked >= 0.8) {
    successfulFlexibility = true;
    alerts.push({
      level: 'info',
      key: 'flexibility',
      message: 'Targets reached on most days using different foods from the plan.',
    });
  }

  return {
    daysTracked,
    daysOnTarget,
    daysUnder,
    daysOver,
    planFollowedDays,
    targetMissedDays,
    missingLoggingStreak,
    repeatedUnderTarget,
    repeatedOverTarget,
    potentialPlanIssue,
    successfulFlexibility,
    alerts,
  };
}

// Repeated macro deficiency across the last `window` logged days (§27).
// macroMissesByDay: [{ date, misses: { protein: bool, ... } }] oldest → newest.
// macrosWithTargets: e.g. ['protein'] — only macros that actually have a
// configured target are monitored.
export function detectRepeatedMacroMisses(macroMissesByDay, macrosWithTargets, { window = 4, threshold = 3 } = {}) {
  const logged = (Array.isArray(macroMissesByDay) ? macroMissesByDay : []).slice(-window);
  const out = [];
  for (const macro of macrosWithTargets || []) {
    const misses = logged.filter((d) => d?.misses?.[macro]).length;
    if (misses >= threshold) {
      out.push({
        macro,
        misses,
        window: logged.length,
        message: `${macro[0].toUpperCase()}${macro.slice(1)} target missed on ${misses} of the last ${logged.length} logged days.`,
        level: 'medium',
        key: `macro_${macro}`,
      });
    }
  }
  return out;
}
