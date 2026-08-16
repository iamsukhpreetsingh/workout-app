const express = require('express');
const trainerClients = require('../data/trainerClients');
const assignedPlans = require('../data/assignedPlans');
const sessionSummaries = require('../data/sessionSummaries');
const measurements = require('../data/measurements');
const sessionDetails = require('../data/sessionDetails');
const coaching = require('../data/coachingPlans');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// POST /client/request-association — client-only, submits invite code
router.post('/request-association', requireAuth, requireRole('user'), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Invite code is required' });
    const row = await trainerClients.requestAssociationByCode(req.user.id, code.trim().toUpperCase());
    res.status(201).json(row);
  } catch (e) {
    httpError(res, e);
  }
});

// POST /client/associations/request — client-only. Trainer is resolved
// from the invite code server-side; ids in the body are never trusted.
router.post('/associations/request', requireAuth, requireRole('user'), async (req, res) => {
  try {
    const { invite_code } = req.body || {};
    if (!invite_code) return res.status(400).json({ error: 'Invite code is required' });
    const row = await trainerClients.requestAssociationByCode(
      req.user.id,
      String(invite_code).trim().toUpperCase()
    );
    res.status(201).json(row);
  } catch (e) {
    httpError(res, e, 400);
  }
});

// GET /client/trainer — client-only. Returns the client's association state:
// { status: 'active'|'pending', trainer info } or null.
router.get('/trainer', requireAuth, requireRole('user'), async (req, res) => {
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
    const rows = await sessionSummaries.upsertSummaries(req.user.id, req.body);
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
  router.get(`/${seg}`, requireAuth, requireRole('user'), async (req, res) => {
    try {
      res.json(await coaching.listActiveForOwner(kind, req.user.id));
    } catch (e) {
      httpError(res, e);
    }
  });

  // self-authored plan creation (no trainer relationship required)
  router.post(`/${seg}`, requireAuth, requireRole('user'), async (req, res) => {
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
        ...(kind === 'diet' ? { targets } : {}),
        createdBy: 'client',
      });
      res.status(201).json(plan);
    } catch (e) {
      httpError(res, e, 400);
    }
  });

  // full nested detail for one of my own plans (drives the client viewer)
  router.get(`/${seg}/:planId`, requireAuth, requireRole('user'), async (req, res) => {
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

  // daily adherence check-in (upsert)
  router.post(`/${seg}/:planId/checkins`, requireAuth, requireRole('user'), async (req, res) => {
    try {
      const { date, followed, taken, note } = req.body || {};
      const day = date || new Date().toISOString().slice(0, 10);
      const done = kind === 'diet' ? followed : taken;
      if (done == null) {
        return res.status(400).json({ error: kind === 'diet' ? 'followed is required' : 'taken is required' });
      }
      res.status(201).json(await coaching.checkIn(kind, req.user.id, req.params.planId, day, done, note));
    } catch (e) {
      httpError(res, e, 400);
    }
  });

  // own recent check-ins (client-side strip)
  router.get(`/${seg}/:planId/checkins`, requireAuth, requireRole('user'), async (req, res) => {
    try {
      res.json(await coaching.listMyCheckins(kind, req.user.id, req.params.planId));
    } catch (e) {
      httpError(res, e);
    }
  });
}

// GET /client/plans — client-only, plans assigned to me
router.get('/plans', requireAuth, requireRole('user'), async (req, res) => {
  try {
    res.json(await assignedPlans.listAssignedPlans({ forClientId: req.user.id }));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /client/assigned-plans — client-only, ACTIVE plans with exercises +
// trainer name (drives the Home "From Your Trainer" section)
router.get('/assigned-plans', requireAuth, requireRole('user'), async (req, res) => {
  try {
    res.json(await assignedPlans.listActiveForClientId(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

module.exports = router;
