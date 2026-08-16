const express = require('express');
const crypto = require('crypto');
const trainerClients = require('../data/trainerClients');
const assignedPlans = require('../data/assignedPlans');
const sessionSummaries = require('../data/sessionSummaries');
const measurements = require('../data/measurements');
const sessionDetails = require('../data/sessionDetails');
const coaching = require('../data/coachingPlans');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const INVITE_TTL_DAYS = 7;

function httpError(res, e, fallback = 500) {
  const status = e.status || fallback;
  res.status(status).json({ error: e.message || 'Unexpected error' });
}

// POST /trainer/invite-code — trainer-only
router.post('/invite-code', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000);
    const invite = await trainerClients.createInviteCode(req.user.id, code, expiresAt);
    res.status(201).json(invite);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/associations?status=pending — trainer-only
router.get('/associations', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const rows = await trainerClients.listAssociations(req.user.id, req.query.status);
    res.json(rows);
  } catch (e) {
    httpError(res, e);
  }
});

// POST /trainer/associations/:id/accept — trainer-only
router.post('/associations/:id/accept', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const row = await trainerClients.respondToAssociation(req.user.id, req.params.id, 'active');
    res.json(row);
  } catch (e) {
    httpError(res, e);
  }
});

// POST /trainer/associations/:id/reject — trainer-only (reject or later revoke)
router.post('/associations/:id/reject', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const row = await trainerClients.respondToAssociation(req.user.id, req.params.id, 'revoked');
    res.json(row);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients — trainer-only, active clients with activity
// aggregates (adherence_pct + last_active_at) computed in one query.
router.get('/clients', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    res.json(await sessionSummaries.clientsWithActivity(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients/:clientId/session-summaries — trainer-only, requires
// an active association with that client; paginated by performed_at DESC.
router.get(
  '/clients/:clientId/session-summaries',
  requireAuth,
  requireRole('trainer'),
  async (req, res) => {
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
  }
);

// ---- Assigned plans (trainer → client) ----

// POST /trainer/plans — trainer-only; requires active association
router.post('/plans', requireAuth, requireRole('trainer'), async (req, res) => {
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
});

// GET /trainer/plans?clientId=... — trainer-only
router.get('/plans', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    res.json(await assignedPlans.listAssignedPlans({ trainerId: req.user.id, clientId: req.query.clientId }));
  } catch (e) {
    httpError(res, e);
  }
});

// ---- Client-scoped assigned plans ----

// POST /trainer/clients/:clientId/assigned-plans — create for an ACTIVE client
router.post('/clients/:clientId/assigned-plans', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, notes, exercises } = req.body || {};
    if (!name || !Array.isArray(exercises) || !exercises.length) {
      return res.status(400).json({ error: 'name and a non-empty exercises array are required' });
    }
    const plan = await assignedPlans.createAssignedPlan({ trainerId: req.user.id, clientId, name, notes, exercises });
    res.status(201).json(plan);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients/:clientId/assigned-plans — active plans (association-checked)
router.get('/clients/:clientId/assigned-plans', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    res.json(await assignedPlans.listActiveForClient(req.user.id, req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});

// PUT /trainer/clients/:clientId/assigned-plans/:planId — update an assigned plan
router.put('/clients/:clientId/assigned-plans/:planId', requireAuth, requireRole('trainer'), async (req, res) => {
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
});

// PATCH /trainer/clients/:clientId/assigned-plans/:planId — status-only update
// (archive). Verifies the plan belongs to this trainer+client pair.
router.patch('/clients/:clientId/assigned-plans/:planId', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (status !== 'archived') {
      return res.status(400).json({ error: "Only status='archived' updates are supported" });
    }
    res.json(await assignedPlans.archiveAssignedPlanForPair(req.user.id, req.params.clientId, req.params.planId));
  } catch (e) {
    httpError(res, e);
  }
});

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

// GET /trainer/clients/:clientId/measurements?metric_type=&from=&to=
router.get('/clients/:clientId/measurements', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
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
});

// GET /trainer/clients/:clientId/measurement-types
router.get('/clients/:clientId/measurement-types', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
    res.json(await measurements.listMeasurementTypes(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients/:clientId/sessions/:sessionSummaryId/details
router.get(
  '/clients/:clientId/sessions/:sessionSummaryId/details',
  requireAuth,
  requireRole('trainer'),
  async (req, res) => {
    try {
      if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
      res.json(await sessionDetails.getDetailsForSummary(req.params.sessionSummaryId));
    } catch (e) {
      httpError(res, e);
    }
  }
);

// GET /trainer/clients/:clientId/exercises — distinct logged exercises
router.get('/clients/:clientId/exercises', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
    res.json(await sessionDetails.listClientExercises(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/clients/:clientId/strength?exercise=&from=&to= — e1RM trend
router.get('/clients/:clientId/strength', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
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
});

// ---- Diet + supplement plans (trainer → client) ----
for (const kind of ['diet', 'supplement']) {
  const seg = kind === 'diet' ? 'diet-plans' : 'supplement-plans';

  router.post(`/clients/:clientId/${seg}`, requireAuth, requireRole('trainer'), async (req, res) => {
    try {
      const { name, notes, items } = req.body || {};
      const plan = await coaching.createPlan(kind, {
        trainerId: req.user.id, clientId: req.params.clientId, name, notes, items,
      });
      res.status(201).json(plan);
    } catch (e) {
      httpError(res, e);
    }
  });

  router.get(`/clients/:clientId/${seg}`, requireAuth, requireRole('trainer'), async (req, res) => {
    try {
      res.json(await coaching.listActiveForClient(kind, req.user.id, req.params.clientId));
    } catch (e) {
      httpError(res, e);
    }
  });

  router.patch(`/clients/:clientId/${seg}/:planId`, requireAuth, requireRole('trainer'), async (req, res) => {
    try {
      if ((req.body || {}).status !== 'archived') {
        return res.status(400).json({ error: "Only status='archived' updates are supported" });
      }
      res.json(await coaching.archivePlan(kind, req.user.id, req.params.clientId, req.params.planId));
    } catch (e) {
      httpError(res, e);
    }
  });

  router.get(`/clients/:clientId/${seg}/:planId/checkins`, requireAuth, requireRole('trainer'), async (req, res) => {
    try {
      res.json(
        await coaching.listCheckins(kind, req.user.id, req.params.clientId, req.params.planId, req.query.from, req.query.to)
      );
    } catch (e) {
      httpError(res, e);
    }
  });

  // plan detail with items (trainer-owned)
  router.get(`/clients/:clientId/${seg}/:planId`, requireAuth, requireRole('trainer'), async (req, res) => {
    try {
      if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
      const plan = await coaching.getPlanWithItems(kind, req.params.planId);
      if (!plan || plan.trainer_id !== req.user.id) return res.status(404).json({ error: 'Plan not found' });
      res.json(plan);
    } catch (e) {
      httpError(res, e);
    }
  });
}

// GET /trainer/clients/:clientId/volume-by-muscle-group?from=&to=
router.get(
  '/clients/:clientId/volume-by-muscle-group',
  requireAuth,
  requireRole('trainer'),
  async (req, res) => {
    try {
      if (!(await requireActiveAssociation(req, res, req.params.clientId))) return;
      res.json(await sessionDetails.volumeByMuscleGroup(req.params.clientId, req.query.from, req.query.to));
    } catch (e) {
      httpError(res, e);
    }
  }
);

// GET /trainer/plans/:id — trainer-only
router.get('/plans/:id', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const plan = await assignedPlans.getAssignedPlan(req.params.id);
    if (!plan || plan.trainer_id !== req.user.id) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json(plan);
  } catch (e) {
    httpError(res, e);
  }
});

// DELETE /trainer/plans/:id — trainer-only
router.delete('/plans/:id', requireAuth, requireRole('trainer'), async (req, res) => {
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
});

module.exports = router;
