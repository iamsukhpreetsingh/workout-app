// nutritionMonitoring.js — exception-first trainer monitoring (Phase D).
//
// The trainer's question is "which clients are doing well, which need
// attention, and why?" — never "what % of meals did they follow?". All
// status/exception math is delegated to nutritionCore (the same algorithm
// the mobile app uses) — no alert logic is duplicated here.
//
// PERMISSION MODEL (unchanged): only TRAINER-ASSIGNED plans are visible.
// Food logs carry plan_server_id (NULL for self-authored plans) and the
// queries below join through it, so a client's private diary stays private.
// Association enforcement (active/30-day-readable window) is asserted here.
const { query } = require('../db/pool');
const coaching = require('./coachingPlans');
const foodLogData = require('./foodLog');
const core = require('./nutritionCore');
const nutritionTargetsService = require('./nutritionTargetsService');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const dayStr = (d) => d.toISOString().slice(0, 10);
const shiftDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayStr(d);
};

// The plan's day→calendar-date mapping is a client-side choice (day tabs),
// so the server approximates follow-through with the plan's FIRST day's
// items — the count of planned items is what matters for "N of M followed",
// and item refs/names are stable for that purpose.
function plannedItemsOfPlan(plan) {
  const items = [];
  const firstDay = (plan.days || [])[0];
  for (const m of firstDay?.meals || []) {
    for (const it of m.items || []) items.push({ id: String(it.id), name: it.name });
  }
  return items;
}

async function getMonitoringForClient(trainerId, clientId, windowDays = 7) {
  await coaching.assertReadableAssociation(trainerId, clientId);
  const plans = await coaching.listActiveForClient('diet', trainerId, clientId);
  const plan = (plans || [])[0] || null; // primary active assigned plan

  const today = dayStr(new Date());
  // Complete days only: the evaluation window ends YESTERDAY (today can
  // never fail a monitoring check while it is still happening).
  const toDate = shiftDays(today, -1);
  const fromDate = shiftDays(toDate, -(windowDays - 1));

  const trackingMode = plan?.tracking_mode === 'detailed' ? 'detailed' : 'simple';
  const tolerance = plan?.tolerance_pct ?? core.DEFAULT_TOLERANCE_PCT;
  const targets = plan
    ? {
        calories: plan.daily_calorie_target,
        protein_g: plan.daily_protein_target,
        carbs_g: plan.daily_carbs_target,
        fat_g: plan.daily_fat_target,
      }
    : {};

  const entries = plan
    ? await foodLogData.listClientFoodLogsForMonitoring(trainerId, clientId, fromDate, toDate)
    : [];

  // Simple mode: outcomes come from the unchanged yes/no check-ins.
  let checkinsByDate = new Map();
  if (plan && trackingMode === 'simple') {
    const rows = await coaching.listCheckins('diet', trainerId, clientId, plan.id, fromDate, toDate);
    checkinsByDate = new Map((rows || []).map((c) => [String(c.date).slice(0, 10), c.followed === true]));
  }

  const macrosWithTargets = ['protein_g', 'carbs_g', 'fat_g'].filter((k) => Number(targets[k]) > 0);
  const macroKeyToName = { protein_g: 'protein', carbs_g: 'carbs', fat_g: 'fat' };

  const plannedItems = plan ? plannedItemsOfPlan(await coaching.getPlanWithItems('diet', plan.id)) : [];

  const days = [];
  const macroMissesByDay = [];
  for (let d = fromDate; d <= toDate; d = shiftDays(d, 1)) {
    const dayEntries = entries.filter((e) => String(e.log_date).slice(0, 10) === d);
    let status;
    let planFollowedRatio = null;
    if (!plan) {
      status = core.STATUS.NOT_LOGGED;
    } else if (trackingMode === 'simple') {
      // Simple days are never given nutrition verdicts (§6): a check-in is
      // the only signal, and no data is fabricated for unanswered days.
      const followed = checkinsByDate.get(d);
      status =
        followed === true ? 'simple_followed' : followed === false ? 'simple_missed' : core.STATUS.NOT_LOGGED;
    } else if (dayEntries.length === 0) {
      status = core.STATUS.NOT_LOGGED;
    } else {
      status = core.evaluateAgainstTarget(
        dayEntries.reduce((n, e) => n + (Number(e.calories) || 0), 0),
        targets.calories,
        tolerance
      ) || core.STATUS.NOT_LOGGED;
      const ft = core.computePlanFollowThrough(plannedItems, dayEntries);
      planFollowedRatio = ft ? ft.completed / ft.total : null;
      const misses = {};
      for (const mk of macrosWithTargets) {
        const actual = dayEntries.reduce((n, e) => n + (Number(e[mk]) || 0), 0);
        misses[macroKeyToName[mk]] =
          core.evaluateAgainstTarget(actual, targets[mk], tolerance) === core.STATUS.UNDER_TARGET;
      }
      macroMissesByDay.push({ date: d, misses });
    }
    days.push({ date: d, status, planFollowedRatio });
  }

  const metrics = core.evaluateClientMonitoring(days);
  // weekly average intake vs target — logged days only
  const loggedCalorieDays = trackingMode === 'detailed'
    ? days
        .filter((d) => d.status !== core.STATUS.NOT_LOGGED)
        .map((d) => {
          const de = entries.filter((e) => String(e.log_date).slice(0, 10) === d.date);
          return {
            actual: de.reduce((n, e) => n + (Number(e.calories) || 0), 0),
            target: Number(targets.calories) || null,
          };
        })
    : [];
  const avgCalories = loggedCalorieDays.length
    ? Math.round(loggedCalorieDays.reduce((n, d) => n + d.actual, 0) / loggedCalorieDays.length)
    : null;
  const avgCaloriesTarget = loggedCalorieDays.some((d) => d.target)
    ? Math.round(
        loggedCalorieDays.reduce((n, d) => n + (d.target || 0), 0) /
          loggedCalorieDays.filter((d) => d.target).length
      )
    : null;

  const macroAlerts = core.detectRepeatedMacroMisses(macroMissesByDay, macrosWithTargets.map((k) => macroKeyToName[k]));
  const LEVEL_ORDER = { high: 0, medium: 1, info: 2 };
  const alerts = [...metrics.alerts, ...macroAlerts].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  // overall status for client-list chips
  let status = 'on_track';
  if (!plan || metrics.daysTracked < 3) status = 'not_enough_data';
  else if (alerts.some((a) => a.level === 'high')) status = 'needs_attention';

  // live today (progress, never a final verdict)
  const todayEntries = plan
    ? (await foodLogData.listClientFoodLogsForMonitoring(trainerId, clientId, today, today)).filter((e) =>
        String(e.log_date).slice(0, 10) === today
      )
    : [];
  const todaySummary = plan
    ? core.computeDailySummary({
        date: today,
        entries: todayEntries,
        targets,
        tolerancePct: tolerance,
        isToday: true,
        planFollowThrough: core.computePlanFollowThrough(plannedItems, todayEntries),
      })
    : null;

  // active target + its SOURCE for trainer context (§19): automatic vs
  // trainer-configured. Best-effort — monitoring never fails on this.
  let activeTargets = null;
  try {
    const t = await nutritionTargetsService.getActiveNutritionTargets(clientId);
    if (t.active) {
      activeTargets = {
        calories: t.active.calories,
        target_source: t.active.target_source,
        recommendation_drift: t.recommendation_drift,
      };
    }
  } catch {}

  return {
    client_id: clientId,
    plan_id: plan?.id || null,
    plan_name: plan?.name || null,
    tracking_mode: trackingMode,
    has_plan: !!plan,
    window_days: windowDays,
    metrics,
    avgCalories,
    avgCaloriesTarget,
    macroAlerts: macroAlerts,
    alerts,
    status,
    days,
    today: todaySummary,
    active_targets: activeTargets,
  };
}

// One call for the client list: "who needs attention?" at a glance.
async function getOverviewForTrainer(trainerId) {
  const { rows: clients } = await query(
    `SELECT u.id AS client_id, u.name AS client_name
     FROM trainer_clients tc JOIN users u ON u.id = tc.client_id
     WHERE tc.trainer_id = $1 AND tc.status = 'active'
     ORDER BY u.name`,
    [trainerId]
  );
  const out = [];
  for (const c of clients) {
    try {
      const m = await getMonitoringForClient(trainerId, c.client_id, 7);
      out.push({
        client_id: c.client_id,
        client_name: c.client_name,
        status: m.status,
        days_tracked: m.metrics.daysTracked,
        days_on_target: m.metrics.daysOnTarget,
        days_under: m.metrics.daysUnder,
        days_over: m.metrics.daysOver,
        top_alert: m.alerts.find((a) => a.level !== 'info')?.message || m.alerts[0]?.message || null,
        has_plan: m.has_plan,
        target_calories: m.active_targets?.calories ?? null,
        target_source: m.active_targets?.target_source ?? null,
      });
    } catch {
      out.push({ client_id: c.client_id, client_name: c.client_name, status: 'not_enough_data', days_tracked: 0, has_plan: false });
    }
  }
  return out;
}

module.exports = {
  getMonitoringForClient,
  getOverviewForTrainer,
};
