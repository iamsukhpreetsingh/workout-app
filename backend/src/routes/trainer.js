const express = require('express');
const crypto = require('crypto');
const trainerClients = require('../data/trainerClients');
const assignedPlans = require('../data/assignedPlans');
const sessionSummaries = require('../data/sessionSummaries');
const measurements = require('../data/measurements');
const sessionDetails = require('../data/sessionDetails');
const coaching = require('../data/coachingPlans');
const mealCatalog = require('../data/mealCatalog');
const workoutTemplates = require('../data/workoutTemplates');
const notifications = require('../data/notifications');
const intakeProfiles = require('../data/intakeProfiles');
const backup = require('../data/backup');
const progressPhotos = require('../data/progressPhotos');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { registerRoute } = require('../admin/registry');

const router = express.Router();
const INVITE_TTL_DAYS = 7;

function httpError(res, e, fallback = 500) {
  const status = e.status || fallback;
  res.status(status).json({ error: e.message || 'Unexpected error' });
}

// POST /trainer/invite-code — trainer-only
registerRoute(router, {
  method: 'POST',
  path: '/invite-code',
  description: 'Generates a new invite code for the authenticated trainer that expires after seven days.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
    const invite = await trainerClients.createInviteCode(req.user.id, code, expiresAt);
    res.status(201).json(invite);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/invite-code/latest — the trainer's most recent still-valid
// code (null if none), so Settings can show the existing code instead of
// silently minting a new one on every open.
registerRoute(router, {
  method: 'GET',
  path: '/invite-code/latest',
  description: "Returns the trainer's most recent still-valid invite code, or null when none exists.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, code, expires_at FROM trainer_invite_codes
       WHERE trainer_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/associations?status=pending — trainer-only
registerRoute(router, {
  method: 'GET',
  path: '/associations',
  description: 'Lists the trainer client associations, optionally filtered by status query parameter.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    const rows = await trainerClients.listAssociations(req.user.id, req.query.status);
    res.json(rows);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// POST /trainer/associations/:id/accept — trainer-only
registerRoute(router, {
  method: 'POST',
  path: '/associations/:id/accept',
  description: 'Accepts a pending client association request on behalf of the trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    const { final_decision } = req.body || {};
    const row = await trainerClients.respondToAssociation(req.user.id, req.params.id, 'accept', final_decision || null);
    res.json(row);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

// POST /trainer/associations/:id/reject — trainer-only (reject or later revoke)
registerRoute(router, {
  method: 'POST',
  path: '/associations/:id/reject',
  description: 'Rejects a pending association request or revokes an existing association for the trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    // reactivations revert to 'archived' internally; new requests revoke
    const row = await trainerClients.respondToAssociation(req.user.id, req.params.id, 'reject');
    res.json(row);
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients — trainer-only, active clients with activity
// aggregates (adherence_pct + last_active_at) computed in one query.
registerRoute(router, {
  method: 'GET',
  path: '/clients',
  description: 'Returns the active client roster with adherence and last-active aggregates.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    res.json(await sessionSummaries.rosterWithArchive(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/session-summaries — trainer-only, requires
// an active association with that client; paginated by performed_at DESC.
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/session-summaries',
  description: 'Returns paginated workout session summaries for a client when an active association exists.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT 1 FROM trainer_clients
         WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'`,
        [req.user.id, req.params.clientId]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'No active association with this client' });
      }
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      res.json(
        await sessionSummaries.listForClient(req.params.clientId, {
          limit,
          offset,
          from: req.query.from,
          to: req.query.to,
        })
      );
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

// ---- Assigned plans (trainer → client) ----

// POST /trainer/plans — trainer-only; requires active association
registerRoute(router, {
  method: 'POST',
  path: '/plans',
  description: 'Creates a new assigned workout plan for a client from the request body.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const { clientId, name, notes, exercises } = req.body || {};
    if (!clientId || !name || !Array.isArray(exercises) || !exercises.length) {
      return res.status(400).json({ error: 'clientId, name and a non-empty exercises array are required' });
    }
    const plan = await assignedPlans.createAssignedPlan({
      trainerId: req.user.id,
      clientId,
      name,
      notes,
      exercises,
    });
    res.status(201).json(plan);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/plans?clientId=... — trainer-only
registerRoute(router, {
  method: 'GET',
  path: '/plans',
  description: "Lists the trainer's assigned plans, optionally filtered by clientId query parameter.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    res.json(await assignedPlans.listAssignedPlans({ trainerId: req.user.id, clientId: req.query.clientId }));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Client-scoped assigned plans ----

// POST /trainer/clients/:clientId/assigned-plans — create for an ACTIVE client
registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/assigned-plans',
  description: 'Creates an assigned workout plan for a specific client and notifies them of the assignment.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, notes, exercises, tags } = req.body || {};
    if (!name || !Array.isArray(exercises) || !exercises.length) {
      return res.status(400).json({ error: 'name and a non-empty exercises array are required' });
    }
    const plan = await assignedPlans.createAssignedPlan({ trainerId: req.user.id, clientId, name, notes, exercises, tags });

    // Create notification for client (always, not gated by trainer preference)
    const trainer = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const trainerName = trainer.rows[0]?.name || 'Your trainer';
    notifications.createNotification({
      recipientId: clientId,
      actorId: req.user.id,
      type: 'workout_assigned',
      title: 'New workout assigned',
      body: `${trainerName} assigned you '${name}'`,
      deepLinkRef: plan.id,
    }).catch(err => console.error('Failed to create notification:', err.message));

    res.status(201).json(plan);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/assigned-plans — active plans (association-checked)
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/assigned-plans',
  description: "Lists the trainer's active assigned plans for a specific client.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    res.json(await assignedPlans.listActiveForClient(req.user.id, req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// PUT /trainer/clients/:clientId/assigned-plans/:planId — update an assigned plan
registerRoute(router, {
  method: 'PUT',
  path: '/clients/:clientId/assigned-plans/:planId',
  description: 'Updates the name, notes and exercises of an assigned plan for a specific client.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const { clientId, planId } = req.params;
    const { name, notes, exercises } = req.body || {};
    if (!name || !Array.isArray(exercises) || !exercises.length) {
      return res.status(400).json({ error: 'name and a non-empty exercises array are required' });
    }
    const plan = await assignedPlans.updateAssignedPlan(planId, req.user.id, clientId, name, notes, exercises);
    res.json(plan);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// PATCH /trainer/clients/:clientId/assigned-plans/:planId — status-only update
// (archive). Verifies the plan belongs to this trainer+client pair.
registerRoute(router, {
  method: 'PATCH',
  path: '/clients/:clientId/assigned-plans/:planId',
  description: 'Archives an assigned plan owned by this trainer-client pair via a status-only update.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (status !== 'archived') {
      return res.status(400).json({ error: "Only status='archived' updates are supported" });
    }
    res.json(await assignedPlans.archiveAssignedPlanForPair(req.user.id, req.params.clientId, req.params.planId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Measurement + drill-down (trainer → client) ----

async function requireActiveAssociation(req, res, clientId) {
  const { rows } = await query(
    `SELECT 1 FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'`,
    [req.user.id, clientId]
  );
  if (!rows.length) {
    res.status(403).json({ error: 'No active association with this client' });
    return false;
  }
  return true;
}

// Reads keep working through the 30-day archive window
async function requireReadableAssociation(req, res, clientId) {
  const { rows } = await query(
    `SELECT 1 FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status IN ('active', 'archived')`,
    [req.user.id, clientId]
  );
  if (!rows.length) {
    res.status(403).json({ error: 'No active association with this client' });
    return false;
  }
  return true;
}

// GET /trainer/clients/:clientId/measurements?metric_type=&from=&to=
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/measurements',
  description: "Lists a client's body measurements filtered by metric type and date range.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Measurements',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(
      await measurements.listMeasurements(req.params.clientId, {
        metricType: req.query.metric_type,
        from: req.query.from,
        to: req.query.to,
      })
    );
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/measurement-types
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/measurement-types',
  description: 'Lists the distinct measurement metric types recorded for a client.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Measurements',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await measurements.listMeasurementTypes(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/sessions/:sessionSummaryId/details
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/sessions/:sessionSummaryId/details',
  description: "Returns the full exercise details of one of a client's workout session summaries.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
    try {
      if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
      res.json(await sessionDetails.getDetailsForSummary(req.params.sessionSummaryId));
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/exercises — distinct logged exercises
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/exercises',
  description: 'Lists the distinct exercises a client has logged in their workout sessions.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await sessionDetails.listClientExercises(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/clients/:clientId/strength?exercise=&from=&to= — e1RM trend
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/strength',
  description: "Returns a client's estimated one-rep-max strength trend for a given exercise over a date range.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    if (!req.query.exercise) {
      return res.status(400).json({ error: 'exercise query parameter is required' });
    }
    res.json(
      await sessionDetails.strengthTrend(
        req.params.clientId,
        req.query.exercise,
        req.query.from,
        req.query.to
      )
    );
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Diet + supplement plans (trainer → client) ----
for (const kind of ['diet', 'supplement']) {
  const seg = kind === 'diet' ? 'diet-plans' : 'supplement-plans';

  registerRoute(router, {
    method: 'POST',
    path: `/clients/:clientId/${seg}`,
    description: `Creates an assigned ${kind} plan for a specific client and notifies them of the assignment.`,
    requiresAuth: true,
    allowedRoles: ['trainer'],
    category: 'Nutrition',
  }, async (req, res) => {
    try {
      const { name, notes, items, days } = req.body || {};
      const targets = kind === 'diet'
        ? {
            daily_calorie_target: req.body?.daily_calorie_target,
            daily_protein_target: req.body?.daily_protein_target,
            daily_carbs_target: req.body?.daily_carbs_target,
            daily_fat_target: req.body?.daily_fat_target,
          }
        : undefined;
      const plan = await coaching.createPlan(kind, {
        trainerId: req.user.id, clientId: req.params.clientId, name, notes, items, days,
        tags: req.body?.tags,
        ...(kind === 'diet' ? { targets } : {}),
      });

      // Create notification for client (always, not gated by trainer preference)
      const trainer = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      const trainerName = trainer.rows[0]?.name || 'Your trainer';
      const notifType = kind === 'diet' ? 'diet_assigned' : 'supplement_assigned';
      const notifTitle = kind === 'diet' ? 'New diet plan assigned' : 'New supplement plan assigned';
      notifications.createNotification({
        recipientId: req.params.clientId,
        actorId: req.user.id,
        type: notifType,
        title: notifTitle,
        body: `${trainerName} assigned you '${name}'`,
        deepLinkRef: plan.id,
      }).catch(err => console.error('Failed to create notification:', err.message));

      res.status(201).json(plan);
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

  registerRoute(router, {
    method: 'GET',
    path: `/clients/:clientId/${seg}`,
    description: `Lists the trainer's active assigned ${kind} plans for a specific client.`,
    requiresAuth: true,
    allowedRoles: ['trainer'],
    category: 'Nutrition',
  }, async (req, res) => {
    try {
      res.json(await coaching.listActiveForClient(kind, req.user.id, req.params.clientId));
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

  registerRoute(router, {
    method: 'PATCH',
    path: `/clients/:clientId/${seg}/:planId`,
    description: kind === 'diet'
      ? 'Archives an assigned diet plan for a specific client.'
      : 'Archives an assigned supplement plan or updates its tags for a specific client.',
    requiresAuth: true,
    allowedRoles: ['trainer'],
    category: 'Nutrition',
  }, async (req, res) => {
    try {
      if ((req.body || {}).status === 'archived') {
        return res.json(await coaching.archivePlan(kind, req.user.id, req.params.clientId, req.params.planId));
      }
      // supplements have no reusable catalog — plan-level tags are set
      // directly on the assigned plan via PATCH (workout tags cascade from
      // templates, diet tags live on recipes instead)
      if (kind === 'supplement' && Array.isArray((req.body || {}).tags)) {
        return res.json(await coaching.updateSupplementPlanTags(req.user.id, req.params.clientId, req.params.planId, req.body.tags));
      }
      return res.status(400).json({ error: "Only status='archived' updates or supplement tags are supported" });
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

  registerRoute(router, {
    method: 'GET',
    path: `/clients/:clientId/${seg}/:planId/checkins`,
    description: `Lists a client's check-ins for an assigned ${kind} plan within an optional date range.`,
    requiresAuth: true,
    allowedRoles: ['trainer'],
    category: 'Nutrition',
  }, async (req, res) => {
    try {
      res.json(
        await coaching.listCheckins(kind, req.user.id, req.params.clientId, req.params.planId, req.query.from, req.query.to)
      );
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

  // plan detail with items (trainer-owned)
  registerRoute(router, {
    method: 'GET',
    path: `/clients/:clientId/${seg}/:planId`,
    description: kind === 'diet'
      ? "Returns an assigned diet plan with its items plus the client's recent dish substitutions."
      : 'Returns an assigned supplement plan with its items.',
    requiresAuth: true,
    allowedRoles: ['trainer'],
    category: 'Nutrition',
  }, async (req, res) => {
    try {
      if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
      const plan = await coaching.getPlanWithItems(kind, req.params.planId);
      if (!plan || plan.trainer_id !== req.user.id) return res.status(404).json({ error: 'Plan not found' });
      if (kind === 'diet') {
        // recent date-scoped dish substitutions the client made while
        // following this assigned plan (empty for self-authored swaps —
        // those carry plan_server_id IS NULL and can never match)
        plan.recent_swaps = await backup.listAssignedPlanSwaps(
          req.user.id, req.params.clientId, req.params.planId
        );
      }
      res.json(plan);
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);
}







// ---- Client intake profile (trainer → client, read-only) ----
// Returns the client's completed intake profile (goals, injuries,
// medical_conditions, allergens) or null when none exists. The app
// skips ALL allergen warnings when this is null — no error, no blocking.
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/intake-profile',
  description: "Returns a client's completed intake profile, or null when none exists.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await intakeProfiles.getProfileForClient(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Outcome-first nutrition monitoring (exception-first, Phase D) ----
// Day-by-day target outcomes + prioritized alerts. Only trainer-assigned
// plans are ever evaluated (plan_server_id filter in the data layer).
const nutritionMonitoring = require('../data/nutritionMonitoring');
const foodLogData = require('../data/foodLog');
const dietNotes = require('../data/dietNotes');

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/diet-monitoring',
  description: "Exception-first monitoring of a client's diet outcomes: daily target statuses, week metrics, and prioritized alerts (missing logging, repeated under/over target, plan-may-need-review, successful flexibility).",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 3), 28);
    res.json(await nutritionMonitoring.getMonitoringForClient(req.user.id, req.params.clientId, days));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/diet-monitoring/overview',
  description: "Diet status for every active client at a glance: who is on track, who needs attention, who has insufficient data.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await nutritionMonitoring.getOverviewForTrainer(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// Trainer day detail — the client's RAW food diary for a date range,
// read-only. Permission rule unchanged: only trainer-assigned plans
// (plan_server_id) are ever returned.
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/diet-food-log',
  description: "Read-only view of a client's synced food diary for assigned plans within a date range (from/to as YYYY-MM-DD).",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await foodLogData.listClientFoodLogs(
      req.user.id, req.params.clientId, req.query.plan_id || null, req.query.from, req.query.to
    ));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// Trainer notes — lightweight, one-way, client-visible (with read receipt).
registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/diet-notes',
  description: 'Leaves a nutrition note for a client (optionally tied to a plan and/or date).',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.status(201).json(await dietNotes.createNote(req.user.id, req.params.clientId, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/diet-notes',
  description: "Lists the trainer's notes for a client.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await dietNotes.listNotesForTrainer(req.user.id, req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Client nutrition profile + active targets (trainer side) ----
// The trainer sees the app's recommendation computed from the client's
// profile and decides: keep the automatic target or override it. Overrides
// open a new target VERSION (history is never rewritten) and retain the
// recommendation + an optional reason for reference.
const nutritionTargetsService = require('../data/nutritionTargetsService');

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/nutrition-targets',
  description: "Returns a client's nutrition profile, the app's calculated recommendation, and the active target with its source (automatic / trainer_override) plus any drift between them.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await nutritionTargetsService.getActiveNutritionTargets(req.params.clientId, req.query.date));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/nutrition-targets/override',
  description: "Overrides the client's automatically calculated targets with trainer-defined calories/macros (opens a new target version; the recommendation is retained; an optional note explains the change).",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    const { calories, protein_g, carbs_g, fat_g, note } = req.body || {};
    res.status(201).json(
      await nutritionTargetsService.setTrainerOverride(req.user.id, req.params.clientId, {
        calories, protein_g, carbs_g, fat_g, note,
      })
    );
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/nutrition-targets/use-recommendation',
  description: "Replaces any trainer override with the app's automatically calculated recommendation for the client (opens a new target version).",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.status(201).json(
      await nutritionTargetsService.useTrainerRecommendation(req.user.id, req.params.clientId)
    );
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Trend-based monitoring (log-first model): weekly digest, not
// compliance policing ----
const nutritionDigest = require('../data/nutritionDigest');
const structureSuggestions = require('../data/structureSuggestions');

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/nutrition-digest',
  description: "Trend-based weekly digest for a client: average intake over LOGGED days, target status (daily or rolling weekly_average mode), plain-language trend lines, logging gaps, and structure suggestions. No compliance percentages.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 3), 30);
    res.json(await nutritionDigest.getTrainerWeeklyDigest(req.user.id, req.params.clientId, days));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/food-diary',
  description: "Read-only browse of a client's actual food diary entries (what they really ate) within an optional date range.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await nutritionDigest.getClientFoodLogForTrainer(
      req.user.id, req.params.clientId, req.query.from, req.query.to
    ));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'PUT',
  path: '/clients/:clientId/nutrition-suggestions',
  description: 'Sets the client\'s advisory structure suggestions (free-text meal-shape guidance; never a requirement, never affects target status).',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await structureSuggestions.setStructureSuggestions(req.user.id, req.params.clientId, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/nutrition-suggestions',
  description: "Lists the client's advisory structure suggestions (trainer view).",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
    res.json(await structureSuggestions.getStructureSuggestions(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);








// GET /trainer/clients/:clientId/volume-by-muscle-group?from=&to=
registerRoute(router, {
  method: 'GET',
  path: '/clients/:clientId/volume-by-muscle-group',
  description: "Returns a client's training volume aggregated by muscle group over a date range.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
    try {
      if (!(await requireReadableAssociation(req, res, req.params.clientId))) return;
      res.json(await sessionDetails.volumeByMuscleGroup(req.params.clientId, req.query.from, req.query.to));
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

// ---- Meal catalog (trainer-owned dish library) ----
registerRoute(router, {
  method: 'POST',
  path: '/meal-catalog',
  description: 'Creates a new dish in the meal catalog owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.status(201).json(await mealCatalog.create(req.user.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/meal-catalog',
  description: "Lists the dishes in the meal catalog owned by the authenticated trainer.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await mealCatalog.list(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/meal-catalog/:id',
  description: 'Updates a meal catalog dish owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    res.json(await mealCatalog.update(req.user.id, req.params.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'DELETE',
  path: '/meal-catalog/:id',
  description: 'Removes a meal catalog dish owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Nutrition',
}, async (req, res) => {
  try {
    await mealCatalog.remove(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
}, [requireAuth, requireRole('trainer')]);

// ---- Workout templates (trainer-owned reusable library) ----
registerRoute(router, {
  method: 'POST',
  path: '/workout-templates',
  description: 'Creates a new workout template in the library owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    res.status(201).json(await workoutTemplates.createTemplate(req.user.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/workout-templates',
  description: 'Lists the workout templates in the library owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    res.json(await workoutTemplates.listTemplates(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'GET',
  path: '/workout-templates/:id',
  description: 'Returns a single workout template owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const tpl = await workoutTemplates.getTemplate(req.user.id, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json(tpl);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'PATCH',
  path: '/workout-templates/:id',
  description: 'Updates a workout template owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    res.json(await workoutTemplates.updateTemplate(req.user.id, req.params.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
}, [requireAuth, requireRole('trainer')]);

registerRoute(router, {
  method: 'DELETE',
  path: '/workout-templates/:id',
  description: 'Deletes a workout template owned by the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    await workoutTemplates.deleteTemplate(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
}, [requireAuth, requireRole('trainer')]);

// Assign a snapshot copy of a template to an active client
registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/assigned-plans/from-template/:templateId',
  description: 'Assigns a snapshot copy of a workout template to a client and notifies them of the assignment.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
    try {
      const plan = await workoutTemplates.assignFromTemplate(
        req.user.id,
        req.params.clientId,
        req.params.templateId
      );

      // Create notification for client (always, not gated by trainer preference)
      const trainer = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      const trainerName = trainer.rows[0]?.name || 'Your trainer';
      notifications.createNotification({
        recipientId: req.params.clientId,
        actorId: req.user.id,
        type: 'workout_assigned',
        title: 'New workout assigned',
        body: `${trainerName} assigned you '${plan.name}'`,
        deepLinkRef: plan.id,
      }).catch(err => console.error('Failed to create notification:', err.message));

      res.status(201).json(plan);
    } catch (e) {
      httpError(res, e);
    }
  }, [requireAuth, requireRole('trainer')]);

// POST /trainer/clients/:clientId/unlink — archive the relationship
// (either party); trainer keeps read-only access for 30 days.
registerRoute(router, {
  method: 'POST',
  path: '/clients/:clientId/unlink',
  description: 'Archives the trainer-client relationship and schedules data purge after a 30-day read-only window.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Relationships',
}, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trainer_clients SET
         status = 'archived', archived_at = now(), archived_by = 'trainer',
         purge_at = now() + interval '30 days'
       WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'
       RETURNING *`,
      [req.user.id, req.params.clientId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No active relationship with this client' });
    }
        // +1 rule: unlink resets all of this client's TRAINER_SHARED photos to
    // PERSONAL (any future trainer starts with a clean slate). Non-fatal on
    // failure — the trainer read endpoint re-checks association + visibility
    // at query time, so a missed reset can never leak a photo.
    try {
      await progressPhotos.resetSharesOnDisconnect(req.params.clientId);
    } catch (err) {
      console.error('[ProgressPhotos] share reset on unlink failed:', err.message);
    }
    res.json(rows[0]);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// GET /trainer/plans/:id — trainer-only
registerRoute(router, {
  method: 'GET',
  path: '/plans/:id',
  description: "Returns a single assigned plan when it belongs to the authenticated trainer.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const plan = await assignedPlans.getAssignedPlan(req.params.id);
    if (!plan || plan.trainer_id !== req.user.id) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json(plan);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// DELETE /trainer/plans/:id — trainer-only
registerRoute(router, {
  method: 'DELETE',
  path: '/plans/:id',
  description: 'Deletes an assigned plan when it belongs to the authenticated trainer.',
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Workouts',
}, async (req, res) => {
  try {
    const plan = await assignedPlans.getAssignedPlan(req.params.id);
    if (!plan || plan.trainer_id !== req.user.id) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    await assignedPlans.deleteAssignedPlan(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

// PATCH /trainer/clients/:clientId/notification-preference — trainer-only
registerRoute(router, {
  method: 'PATCH',
  path: '/clients/:clientId/notification-preference',
  description: "Enables or disables the trainer's notifications for a specific client.",
  requiresAuth: true,
  allowedRoles: ['trainer'],
  category: 'Notifications',
}, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    const result = await notifications.updateTrainerNotificationPreference(
      req.user.id,
      req.params.clientId,
      enabled
    );
    res.json(result);
  } catch (e) {
    httpError(res, e);
  }
}, [requireAuth, requireRole('trainer')]);

module.exports = router;
