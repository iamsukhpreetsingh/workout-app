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
const progressPhotos = require('../data/progressPhotos');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { registerRoute } = require('../admin/registry');

const router = express.Router();

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// POST /client/request-association — client-only, submits invite code
registerRoute(router, {
  method: 'POST',
  path: '/request-association',
  description: 'Submits an invite code to request association with a trainer.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
registerRoute(router, {
  method: 'GET',
  path: '/trainer-code-preview',
  description: "Previews a trainer invite code, surfacing the trainer's identity and whether this would be a reactivation.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
registerRoute(router, {
  method: 'POST',
  path: '/associations/request',
  description: 'Requests association with a trainer using an invite code resolved server-side from the authenticated client.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
registerRoute(router, {
  method: 'POST',
  path: '/trainer/unlink',
  description: 'Archives the active trainer relationship, giving the trainer read-only access for 30 days.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
        // +1 rule: unlink resets all of this client's TRAINER_SHARED photos to
    // PERSONAL (any future trainer starts with a clean slate). Non-fatal on
    // failure — the trainer read endpoint re-checks association + visibility
    // at query time, so a missed reset can never leak a photo.
    try {
      await progressPhotos.resetSharesOnDisconnect(req.user.id);
    } catch (err) {
      console.error('[ProgressPhotos] share reset on unlink failed:', err.message);
    }
    res.json(rows[0]);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/trainer — client-only. Returns the client's association state:
// { status: 'active'|'pending', trainer info } or null.
registerRoute(router, {
  method: 'GET',
  path: '/trainer',
  description: "Returns the client's current trainer association state, including status and trainer info, or null if none exists.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await trainerClients.getAssociationStateForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// POST /client/session-summaries — batch upsert of aggregate summaries.
// Any authenticated user may sync their own workouts; client_id is taken
// from the token, never the body.
registerRoute(router, {
  method: 'POST',
  path: '/session-summaries',
  description: 'Batch upserts aggregate workout summaries for the authenticated user and notifies their trainer about genuinely new sessions.',
  requiresAuth: true,
  allowedRoles: ['user'],
  category: 'Workouts',
}, [requireAuth], async (req, res) => {
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
registerRoute(router, {
  method: 'POST',
  path: '/measurements',
  description: 'Batch upserts body-metric measurement entries for the authenticated user.',
  requiresAuth: true,
  allowedRoles: ['user'],
  category: 'Measurements',
}, [requireAuth], async (req, res) => {
  try {
    const rows = await measurements.upsertMeasurements(req.user.id, req.body);
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// POST /client/session-exercise-details — per-set drill-down, sent after
// the corresponding summary sync (needs the server-assigned summary id).
registerRoute(router, {
  method: 'POST',
  path: '/session-exercise-details',
  description: 'Batch upserts per-set exercise drill-down details that follow a synced session summary.',
  requiresAuth: true,
  allowedRoles: ['user'],
  category: 'Workouts',
}, [requireAuth], async (req, res) => {
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
  registerRoute(router, {
    method: 'GET',
    path: `/${seg}`,
    description: `Lists the authenticated client's active ${kind} plans with their items and trainer name.`,
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
    try {
      res.json(await coaching.listActiveForOwner(kind, req.user.id));
    } catch (e) {
      httpError(res, e);
    }
  });

  // self-authored plan creation (no trainer relationship required)
  registerRoute(router, {
    method: 'POST',
    path: `/${seg}`,
    description: `Creates a self-authored ${kind} plan for the authenticated client without requiring a trainer relationship.`,
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
  registerRoute(router, {
    method: 'GET',
    path: `/${seg}/:planId`,
    description: `Returns the full nested detail of one of the client's own ${kind} plans, including the trainer name when applicable.`,
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
  registerRoute(router, {
    method: 'PATCH',
    path: `/${seg}/:planId`,
    description: "Updates a client-authored plan owned by the authenticated user, replacing its full content tree.",
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
  registerRoute(router, {
    method: 'DELETE',
    path: `/${seg}/:planId`,
    description: "Deletes a client-authored plan owned by the authenticated user.",
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
    try {
      await coaching.deleteOwnPlan(kind, req.user.id, req.params.planId);
      res.json({ ok: true });
    } catch (e) {
      httpError(res, e, 404);
    }
  });

  // daily adherence check-in (upsert)
  registerRoute(router, {
    method: 'POST',
    path: `/${seg}/:planId/checkins`,
    description: `Upserts a daily adherence check-in on a ${kind} plan and notifies the trainer if it is a trainer-created plan.`,
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
  registerRoute(router, {
    method: 'GET',
    path: `/${seg}/:planId/checkins`,
    description: `Lists the authenticated client's recent adherence check-ins for one of their ${kind} plans.`,
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Nutrition',
  }, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
registerRoute(router, {
  method: 'GET',
  path: '/intake-profile',
  description: "Returns the client's intake profile (allergens, goals, injuries, medical context) used for allergen conflict warnings.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await intakeProfiles.getProfileForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});











// PUT /client/intake-profile — create or replace my profile. Full form
// submit, used by BOTH the onboarding gate and later edits from settings.
// completed_at is stamped on every successful save.
registerRoute(router, {
  method: 'PUT',
  path: '/intake-profile',
  description: "Creates or fully replaces the client's intake profile and stamps completed_at on every successful save.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Relationships',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
// Read-only view of the ACTIVE trainer's Meal Catalog — powers the diet
// plan viewer's "Choose a different dish" swap fallback (the client
// following a trainer's plan may substitute from that trainer's dishes).
registerRoute(router, {
  method: 'GET',
  path: '/coach-dishes',
  description: "Lists the active trainer's meal catalog dishes so the client can substitute dishes while following a trainer's plan.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    const t = await trainerClients.getActiveTrainerForClient(req.user.id);
    if (!t) return res.json([]);
    res.json(await mealCatalog.list(t.id));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'GET',
  path: '/my-dishes',
  description: "Lists the authenticated user's own dishes in their personal catalog.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await mealCatalog.listUserDishes(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Trainer nutrition notes (client side) ----
// The client can read the trainer's notes and mark them read; per-note read
// state lets the app surface new notes without a notification system.
const dietNotes = require('../data/dietNotes');

registerRoute(router, {
  method: 'GET',
  path: '/diet-notes',
  description: "Lists the client's trainer nutrition notes (newest first, with trainer name and read state).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await dietNotes.listNotesForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'POST',
  path: '/diet-notes/:id/read',
  description: "Marks one of the client's trainer notes as read.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await dietNotes.markNoteRead(req.user.id, req.params.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Active nutrition targets (client side) ----
// The ONE authoritative target service (profile → recommendation →
// versioned active target). The diet system consumes this; no screen
// re-derives targets from the profile.
const nutritionTargetsService = require('../data/nutritionTargetsService');

registerRoute(router, {
  method: 'GET',
  path: '/nutrition-targets',
  description: "Returns the caller's active nutrition target (with its source: automatic or trainer override), the current app recommendation, and whether the profile supports a calculation.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await nutritionTargetsService.getActiveNutritionTargets(req.user.id, req.query.date));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Log-first nutrition (migration 040): the daily food log is the core
// entity for every user; search/targets/suggestions are overlays. ----
const nutritionLog = require('../data/nutritionLog');
const nutritionDigest = require('../data/nutritionDigest');
const structureSuggestions = require('../data/structureSuggestions');

registerRoute(router, {
  method: 'GET',
  path: '/food-search',
  description: 'Three-layer food search (global database incl. seeded staples and cached Open Food Facts results, personal recipes, trainer catalog, custom dishes) with an Open Food Facts fall-through. Supports ?q= and exact ?barcode=.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await nutritionLog.searchFoods(req.user.id, { q: req.query.q, barcode: req.query.barcode }));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'GET',
  path: '/food-log',
  description: "The caller's food diary entries for a date (?date=YYYY-MM-DD, default today).",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await nutritionLog.listFoodLogForDate(req.user.id, req.query.date || new Date().toISOString().slice(0, 10)));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'GET',
  path: '/food-log/recent-frequent',
  description: 'Recently and most-frequently logged foods for low-friction re-logging.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await nutritionLog.recentAndFrequentFoods(req.user.id, Number(req.query.limit) || 10));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'GET',
  path: '/nutrition-suggestions',
  description: 'Advisory meal-shape suggestions (display-only guidance; never gates anything).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await structureSuggestions.getStructureSuggestions(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'PUT',
  path: '/nutrition-suggestions',
  description: 'Replaces the caller\'s own structure suggestions (self-guidance).',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await structureSuggestions.setSelfSuggestions(req.user.id, req.body));
  } catch (e) {
    httpError(res, e, 400);
  }
});

registerRoute(router, {
  method: 'POST',
  path: '/nutrition-targets/self',
  description: "Sets the caller's own calorie/macro targets (source 'self', opens a new target version). Supports target_mode 'daily' or 'weekly_average'.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    const { calories, protein_g, carbs_g, fat_g, tolerance_pct, target_mode } = req.body || {};
    res.status(201).json(
      await nutritionTargetsService.setSelfTargets(req.user.id, { calories, protein_g, carbs_g, fat_g, tolerance_pct, target_mode })
    );
  } catch (e) {
    httpError(res, e, 400);
  }
});

registerRoute(router, {
  method: 'GET',
  path: '/nutrition-weekly-digest',
  description: "Trend-based weekly digest: per-day totals (not-logged days excluded from averages), target status ('daily' or rolling 'weekly_average' mode), plain-language trend lines, and structure suggestions.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await nutritionDigest.getWeeklyDigest(req.user.id, { days: Math.min(Number(req.query.days) || 7, 30) }));
  } catch (e) {
    httpError(res, e);
  }
});

registerRoute(router, {
  method: 'POST',
  path: '/my-dishes',
  description: 'Creates a new dish in the authenticated user\'s personal dish catalog.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.status(201).json(await mealCatalog.createUserDish(req.user.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

registerRoute(router, {
  method: 'PATCH',
  path: '/my-dishes/:id',
  description: "Updates a dish in the authenticated user's personal dish catalog by id.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await mealCatalog.updateUserDish(req.user.id, req.params.id, req.body || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

registerRoute(router, {
  method: 'DELETE',
  path: '/my-dishes/:id',
  description: "Removes a dish from the authenticated user's personal dish catalog by id.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Nutrition',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    await mealCatalog.removeUserDish(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
});

// GET /client/plans — client-only, plans assigned to me
registerRoute(router, {
  method: 'GET',
  path: '/plans',
  description: "Lists all workout plans assigned to the authenticated client.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Workouts',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await assignedPlans.listAssignedPlans({ forClientId: req.user.id }));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/assigned-plans — client-only, ACTIVE plans with exercises +
// trainer name (drives the Home "From Your Trainer" section)
registerRoute(router, {
  method: 'GET',
  path: '/assigned-plans',
  description: "Lists the client's active assigned plans with exercises and trainer name for the Home screen.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Workouts',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await assignedPlans.listActiveForClientId(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Workout Templates Sync (offline-first) ----
// POST /client/workout-templates — batch upsert user-created workout plans
registerRoute(router, {
  method: 'POST',
  path: '/workout-templates',
  description: 'Batch upserts user-created workout templates for offline-first sync.',
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Workouts',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    const rows = await workoutTemplatesSync.upsertTemplates(req.user.id, req.body);
    res.status(201).json(rows);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// GET /client/workout-templates — list all user's workout templates
registerRoute(router, {
  method: 'GET',
  path: '/workout-templates',
  description: "Lists all of the authenticated user's workout templates.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Workouts',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    res.json(await workoutTemplatesSync.listForClient(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// DELETE /client/workout-templates/:localId — delete a workout template
registerRoute(router, {
  method: 'DELETE',
  path: '/workout-templates/:localId',
  description: "Deletes one of the authenticated user's workout templates by its local id.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Workouts',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
  try {
    await workoutTemplatesSync.deleteForClient(req.user.id, req.params.localId);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e, 404);
  }
});

// ---- Full Sync Pull ----
// GET /client/sync/pull — get all user data (for initial login or restore)
registerRoute(router, {
  method: 'GET',
  path: '/sync/pull',
  description: "Pulls all of the user's synced data (sessions, templates, measurements, session details) for initial login or restore.",
  requiresAuth: true,
  allowedRoles: ['user', 'trainer'],
  category: 'Sync',
}, [requireAuth, requireRole(['user', 'trainer'])], async (req, res) => {
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
