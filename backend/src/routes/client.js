const express = require('express');
const trainerClients = require('../data/trainerClients');
const assignedPlans = require('../data/assignedPlans');
const sessionSummaries = require('../data/sessionSummaries');
const measurements = require('../data/measurements');
const sessionDetails = require('../data/sessionDetails');
const mealCatalog = require('../data/mealCatalog');
const coaching = require('../data/coachingPlans');
const notifications = require('../data/notifications');
const workoutTemplatesSync = require('../data/workoutTemplatesSync');
const intakeProfiles = require('../data/intakeProfiles');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// POST /client/request-association — client-only, submits invite code
router.post('/request-association', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Invite code is required' });
    const row = await trainerClients.requestAssociationByCode(req.user.id, code.trim().toUpperCase());
    res.status(201).json(row);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/trainer-code-preview?code=XXX — client-only. Surfaces
// trainer identity + whether this is a reactivation (with counts).
router.get('/trainer-code-preview', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const { code } = req.query || {};
    if (!code) return res.status(400).json({ error: 'code query parameter is required' });
    res.json(await trainerClients.trainerCodePreview(req.user.id, String(code).trim().toUpperCase()));
  } catch (e) {
    httpError(res, e, 400);
  }
});

// POST /client/associations/request — client-only. Trainer is resolved
// from the invite code server-side; ids in the body are never trusted.
router.post('/associations/request', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const { invite_code, restore_preference } = req.body || {};
    if (!invite_code) return res.status(400).json({ error: 'Invite code is required' });
    const row = await trainerClients.requestAssociationByCode(
      req.user.id,
      String(invite_code).trim().toUpperCase(),
      restore_preference || null
    );
    res.status(201).json(row);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// POST /client/trainer/unlink — archive the active relationship. Trainer
// keeps read-only access for 30 days; trainer-created content disappears
// from this client's app immediately.
router.post('/trainer/unlink', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE trainer_clients SET
         status = 'archived', archived_at = now(), archived_by = 'client',
         purge_at = now() + interval '30 days'
       WHERE client_id = $1 AND status = 'active'
       RETURNING *`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No active trainer relationship' });
    }
    res.json(rows[0]);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/trainer — client-only. Returns the client's association state:
// { status: 'active'|'pending', trainer info } or null.
router.get('/trainer', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await trainerClients.getAssociationStateForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// POST /client/session-summaries — batch upsert of aggregate summaries.
// Any authenticated user may sync their own workouts; client_id is taken
// from the token, never the body.
router.post('/session-summaries', requireAuth, async (req, res) => {
  try {
    const summaries = req.body;
    const rows = await sessionSummaries.upsertSummaries(req.user.id, summaries);

    // Check for genuinely NEW sessions (not updates) and notify trainer if applicable
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const insertedRow = rows[i];
      if (!insertedRow) continue;

      // Check if this was actually a new insert (not an update)
      const existing = await query(
        'SELECT id, performed_at FROM session_summaries WHERE client_id = $1 AND local_session_id = $2 AND id != $3',
        [req.user.id, String(s.local_session_id), insertedRow.id]
      );

      // If there's an older row, this is an update, not a new session
      if (existing.rows.length > 0) continue;

      // This is a genuinely new session - check if client has a trainer
      const trainerRel = await notifications.getActiveTrainerForClient(req.user.id);
      if (!trainerRel) continue;

      // Check trainer notification preference
      const pref = await notifications.getTrainerNotificationPreference(trainerRel.trainer_id, req.user.id);
      if (!pref) continue; // Trainer has disabled notifications for this client

      // Get client name
      const clientUser = await notifications.getUserById(req.user.id);
      const clientName = clientUser?.name || 'Your client';

      // Format volume
      const volume = insertedRow.total_volume ? `${Math.round(insertedRow.total_volume)}kg` : '';

      notifications.createNotification({
        recipientId: trainerRel.trainer_id,
        actorId: req.user.id,
        type: 'workout_completed',
        title: `${clientName} completed a workout`,
        body: insertedRow.name ? `'${insertedRow.name}'${volume ? ' · ' + volume + ' volume' : ''}` : `Workout completed${volume ? ' · ' + volume + ' volume' : ''}`,
        relatedClientId: req.user.id,
        deepLinkRef: insertedRow.id,
      }).catch(err => console.error('Failed to create notification:', err.message));
    }

    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// POST /client/measurements — batch upsert of body-metric entries
router.post('/measurements', requireAuth, async (req, res) => {
  try {
    const rows = await measurements.upsertMeasurements(req.user.id, req.body);
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// POST /client/session-exercise-details — per-set drill-down, sent after
// the corresponding summary sync (needs the server-assigned summary id).
router.post('/session-exercise-details', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await sessionDetails.upsertSessionDetails(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

// ---- Client-facing diet + supplement plans ----
for (const kind of ['diet', 'supplement']) {
  const seg = kind === 'diet' ? 'diet-plans' : 'supplement-plans';

  // own active plans (with items + trainer name)
  router.get(`/${seg}`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      res.json(await coaching.listActiveForOwner(kind, req.user.id));
    } catch (e) {
      httpError(res, e);
    }
  });

  // self-authored plan creation (no trainer relationship required)
  router.post(`/${seg}`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
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
        clientId: req.user.id, name, notes, items, days,
        tags: req.body?.tags,
        ...(kind === 'diet' ? { targets } : {}),
        createdBy: 'client',
      });
      res.status(201).json(plan);
    } catch (e) {
      httpError(res, e, 400);
    }
  });

  // full nested detail for one of my own plans (drives the client viewer)
  router.get(`/${seg}/:planId`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      const plan = await coaching.getPlanWithItems(kind, req.params.planId);
      if (!plan || plan.client_id !== req.user.id) {
        return res.status(404).json({ error: 'Plan not found' });
      }
      if (plan.trainer_id) {
        const { rows } = await query('SELECT name FROM users WHERE id = $1', [plan.trainer_id]);
        plan.trainer_name = rows[0]?.name || null;
      }
      res.json(plan);
    } catch (e) {
      httpError(res, e);
    }
  });

  // update my own client-authored diet plan (full tree replace)
  router.patch(`/${seg}/:planId`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      const { name, notes, items, days } = req.body || {};
      
      if (kind === 'diet') {
        if (!name || !Array.isArray(days) || !days.length) {
          return res.status(400).json({ error: 'name and a non-empty days array are required' });
        }
        res.json(
          await coaching.updateOwnDietPlan(req.user.id, req.params.planId, {
            name, notes, days, tags: req.body?.tags,
            targets: {
              daily_calorie_target: req.body?.daily_calorie_target,
              daily_protein_target: req.body?.daily_protein_target,
              daily_carbs_target: req.body?.daily_carbs_target,
              daily_fat_target: req.body?.daily_fat_target,
            },
          })
        );
      } else if (kind === 'supplement') {
        if (!name) {
          return res.status(400).json({ error: 'name is required' });
        }
        if (!Array.isArray(items) || !items.length) {
          return res.status(400).json({ error: 'items array is required' });
        }
        res.json(
          await coaching.updateOwnSupplementPlan(req.user.id, req.params.planId, {
            name, notes, items, tags: req.body?.tags,
          })
        );
      } else {
        return res.status(400).json({ error: 'Unsupported plan kind' });
      }
    } catch (e) {
      httpError(res, e, 400);
    }
  });

  // delete my own client-authored plan
  router.delete(`/${seg}/:planId`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      await coaching.deleteOwnPlan(kind, req.user.id, req.params.planId);
      res.json({ ok: true });
    } catch (e) {
      httpError(res, e, 404);
    }
  });

  // daily adherence check-in (upsert)
  router.post(`/${seg}/:planId/checkins`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      const { date, followed, taken, note } = req.body || {};
      const day = date || new Date().toISOString().slice(0, 10);
      const done = kind === 'diet' ? followed : taken;
      if (done == null) {
        return res.status(400).json({ error: kind === 'diet' ? 'followed is required' : 'taken is required' });
      }
      const checkin = await coaching.checkIn(kind, req.user.id, req.params.planId, day, done, note);

      // Check if this is a trainer-created plan and notify trainer
      const planCreator = await notifications.getPlanCreator(kind, req.params.planId);
      if (planCreator && planCreator.created_by === 'trainer' && planCreator.trainer_id) {
        // Check trainer notification preference
        const pref = await notifications.getTrainerNotificationPreference(planCreator.trainer_id, req.user.id);
        if (pref) {
          // Get client name
          const clientUser = await notifications.getUserById(req.user.id);
          const clientName = clientUser?.name || 'Your client';
          const planName = checkin[`${kind}_plan_id`];

          // Get plan name
          const planTable = kind === 'diet' ? 'diet_plans' : 'supplement_plans';
          const { rows: planRows } = await query(`SELECT name FROM ${planTable} WHERE id = $1`, [req.params.planId]);
          const planNameVal = planRows[0]?.name || 'plan';

          notifications.createNotification({
            recipientId: planCreator.trainer_id,
            actorId: req.user.id,
            type: kind === 'diet' ? 'diet_checkin' : 'supplement_checkin',
            title: `${clientName} checked in on their ${kind} plan`,
            body: done ? `Followed '${planNameVal}'` : `Didn't follow '${planNameVal}'`,
            relatedClientId: req.user.id,
            deepLinkRef: req.params.planId,
          }).catch(err => console.error('Failed to create notification:', err.message));
        }
      }

      res.status(201).json(checkin);
    } catch (e) {
      httpError(res, e, 400);
    }
  });

  // own recent check-ins (client-side strip)
  router.get(`/${seg}/:planId/checkins`, requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
    try {
      res.json(await coaching.listMyCheckins(kind, req.user.id, req.params.planId));
    } catch (e) {
      httpError(res, e);
    }
  });
}








// ---- Client intake profile (health context — sensitive) ----
// ONE profile per client, shared across all their trainers. allergens
// drive the trainer-side conflict warnings; goals/injuries/medical are
// display-only context. completed_at gates ALL allergen checking — a
// missing or incomplete profile means "skip warnings, no error".
// Never include this data in notification bodies or logs.
router.get('/intake-profile', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await intakeProfiles.getProfileForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});











// PUT /client/intake-profile — create or replace my profile. Full form
// submit, used by BOTH the onboarding gate and later edits from settings.
// completed_at is stamped on every successful save.
router.put('/intake-profile', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const {
      allergens = [],
      goals = [],
      injuries = null,
      medical_conditions = null,
    } = req.body || {};

    if (!Array.isArray(allergens) || allergens.some(a => typeof a !== 'string')) {
      return res.status(400).json({ error: 'allergens must be an array of strings' });
    }
    if (!Array.isArray(goals) || goals.some(g => typeof g !== 'string')) {
      return res.status(400).json({ error: 'goals must be an array of strings' });
    }
    if (injuries != null && typeof injuries !== 'string') {
      return res.status(400).json({ error: 'injuries must be a string' });
    }
    if (medical_conditions != null && typeof medical_conditions !== 'string') {
      return res.status(400).json({ error: 'medical_conditions must be a string' });
    }

    res.json(
      await intakeProfiles.upsertProfile(req.user.id, {
        allergens,
        goals,
        injuries,
        medical_conditions,
      })
    );
  } catch (e) {
    httpError(res, e);
  }
});










// ---- My Dishes (user-owned catalog) ----
router.get('/my-dishes', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await mealCatalog.listUserDishes(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

router.post('/my-dishes', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.status(201).json(await mealCatalog.createUserDish(req.user.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.patch('/my-dishes/:id', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await mealCatalog.updateUserDish(req.user.id, req.params.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/my-dishes/:id', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    await mealCatalog.removeUserDish(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
});

// GET /client/plans — client-only, plans assigned to me
router.get('/plans', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await assignedPlans.listAssignedPlans({ forClientId: req.user.id }));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/assigned-plans — client-only, ACTIVE plans with exercises +
// trainer name (drives the Home "From Your Trainer" section)
router.get('/assigned-plans', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await assignedPlans.listActiveForClientId(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Workout Templates Sync (offline-first) ----
// POST /client/workout-templates — batch upsert user-created workout plans
router.post('/workout-templates', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const rows = await workoutTemplatesSync.upsertTemplates(req.user.id, req.body);
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// GET /client/workout-templates — list all user's workout templates
router.get('/workout-templates', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    res.json(await workoutTemplatesSync.listForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// DELETE /client/workout-templates/:localId — delete a workout template
router.delete('/workout-templates/:localId', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    await workoutTemplatesSync.deleteForClient(req.user.id, req.params.localId);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
});

// ---- Full Sync Pull ----
// GET /client/sync/pull — get all user data (for initial login or restore)
router.get('/sync/pull', requireAuth, requireRole(['user', 'trainer']), async (req, res) => {
  try {
    const [sessions, templates, meas, sessionDetailsData] = await Promise.all([
      sessionSummaries.listForClient(req.user.id, { limit: 1000 }),
      workoutTemplatesSync.listForClient(req.user.id).catch(() => []),
      measurements.listMeasurements(req.user.id, {}).catch(() => []),
      sessionDetails.listForClient ? sessionDetails.listForClient(req.user.id).catch(() => ({})) : Promise.resolve({}),
    ]);
    res.json({
      sessions,
      workout_templates: templates,
      measurements: meas,
      session_details: sessionDetailsData,
      pulled_at: new Date().toISOString(),
    });
  } catch (e) {
    httpError(res, e);
  }
});

module.exports = router;
