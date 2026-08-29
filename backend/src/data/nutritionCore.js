// nutritionCore.js — CommonJS MIRROR of the mobile domain core
// (workout-app/src/features/diet/domain/nutritionCore.js). The backend
// monitoring service must apply the IDENTICAL target-status / follow-through
// / exception algorithms as the client. The two files MUST stay
// behaviorally identical — both are covered by test suites asserting the
// same scenarios (tolerance boundaries, follow-through, monitoring rules).
//
// Key invariants (do not weaken):
//  - Calories are the headline; each macro is evaluated independently.
//  - `not_logged` is its own state — never "0/X under target".
//  - Tolerance boundaries are inclusive (actual == bound is on_target);
//    comparisons are cross-multiplied integers so documented boundary
//    values compare exactly with no float division on the boundary.
//  - Plan follow-through NEVER determines the day's verdict.

const STATUS = {
  ON_TARGET: 'on_target',
  UNDER_TARGET: 'under_target',
  OVER_TARGET: 'over_target',
  NOT_LOGGED: 'not_logged',
  IN_PROGRESS: 'in_progress',
};

const DEFAULT_TOLERANCE_PCT = 10;

const normName = (s) => String(s || '').trim().toLowerCase();

function evaluateAgainstTarget(actual, target, tolerancePct = DEFAULT_TOLERANCE_PCT) {
  const a = Number(actual) || 0;
  const t = Number(target);
  if (t == null || !isFinite(t) || t <= 0) return null;
  const tol = Number(tolerancePct ?? DEFAULT_TOLERANCE_PCT);
  const pct = isFinite(tol) && tol >= 0 ? tol : DEFAULT_TOLERANCE_PCT;
  const scaled = a * 100;
  if (scaled < t * (100 - pct)) return STATUS.UNDER_TARGET;
  if (scaled > t * (100 + pct)) return STATUS.OVER_TARGET;
  return STATUS.ON_TARGET;
}

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

function computePlanFollowThrough(plannedItems, entries) {
  const items = Array.isArray(plannedItems) ? plannedItems : [];
  const total = items.length;
  if (total === 0) return null;
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
    if (refs.has(String(item?.id ?? '')) || loggedNames.has(normName(item?.name))) completed += 1;
  }
  return { completed, total };
}

function computeDailySummary({ date, entries, targets = {}, tolerancePct, isToday = false, planFollowThrough = null }) {
  const list = Array.isArray(entries) ? entries : [];
  const sum = (key) => list.reduce((n, e) => n + (Number(e?.[key]) || 0), 0);
  const cal = sum('calories');

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
  const headline = isToday && calStatus === STATUS.UNDER_TARGET ? STATUS.IN_PROGRESS : calStatus;

  const ratio = followThrough && followThrough.total ? followThrough.completed / followThrough.total : 0;
  let contextualInsight = null;
  if (calStatus === STATUS.ON_TARGET && followThrough && ratio < 0.5) {
    contextualInsight = 'You reached your targets with different foods today.';
  } else if (calStatus && calStatus !== STATUS.ON_TARGET && followThrough && ratio >= 0.8) {
    contextualInsight = 'You followed the planned meals, but the day’s nutrition target was missed.';
  }

  return {
    date,
    isLogged: true,
    isToday: !!isToday,
    calories: nutrientBlock(cal, targets.calories, tolerancePct),
    macros: {
      protein: nutrientBlock(sum('protein_g'), targets.protein_g, tolerancePct),
      carbs: nutrientBlock(sum('carbs_g'), targets.carbs_g, tolerancePct),
      fat: nutrientBlock(sum('fat_g'), targets.fat_g, tolerancePct),
    },
    targetStatus: headline,
    planFollowThrough: followThrough,
    contextualInsight,
  };
}

// dayOutcomes: [{ date, status, planFollowedRatio }] oldest → newest over
// the window. status ∈ STATUS.* | 'simple_followed' | 'simple_missed'.
function evaluateClientMonitoring(dayOutcomes) {
  const days = Array.isArray(dayOutcomes) ? dayOutcomes : [];
  const isLoggedDay = (d) => d.status !== STATUS.NOT_LOGGED;
  const tracked = days.filter(isLoggedDay);
  const daysTracked = tracked.length;
  const daysOnTarget = tracked.filter((d) => d.status === STATUS.ON_TARGET || d.status === 'simple_followed').length;
  const daysUnder = tracked.filter((d) => d.status === STATUS.UNDER_TARGET || d.status === 'simple_missed').length;
  const daysOver = tracked.filter((d) => d.status === STATUS.OVER_TARGET).length;
  const planFollowedDays = days.filter((d) => d.planFollowedRatio != null && d.planFollowedRatio >= 0.8).length;
  const targetMissedDays = daysUnder + daysOver;

  let missingLoggingStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].status === STATUS.NOT_LOGGED) missingLoggingStreak += 1;
    else break;
  }

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
    alerts.push({ level: 'high', key: 'missing_logging', message: `No food logged for ${missingLoggingStreak} days.` });
  }
  if (repeatedUnderTarget >= 3) {
    alerts.push({ level: 'high', key: 'repeated_under', message: `Client has been under calorie target for ${repeatedUnderTarget} days.` });
  }
  if (repeatedOverTarget >= 3) {
    alerts.push({ level: 'high', key: 'repeated_over', message: `Client has exceeded calorie target for ${repeatedOverTarget} days.` });
  }

  let potentialPlanIssue = false;
  if (daysTracked >= 3 && planFollowedDays / daysTracked >= 0.8 && targetMissedDays >= 3) {
    potentialPlanIssue = true;
    alerts.push({ level: 'high', key: 'plan_review', message: 'Plan may need review — targets were missed even on days the plan was followed.' });
  }

  let successfulFlexibility = false;
  if (daysTracked >= 3 && planFollowedDays / daysTracked < 0.5 && daysOnTarget / daysTracked >= 0.8) {
    successfulFlexibility = true;
    alerts.push({ level: 'info', key: 'flexibility', message: 'Targets reached on most days using different foods from the plan.' });
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

function detectRepeatedMacroMisses(macroMissesByDay, macrosWithTargets, { window = 4, threshold = 3 } = {}) {
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

module.exports = {
  STATUS,
  DEFAULT_TOLERANCE_PCT,
  evaluateAgainstTarget,
  nutrientBlock,
  computePlanFollowThrough,
  computeDailySummary,
  evaluateClientMonitoring,
  detectRepeatedMacroMisses,
};
