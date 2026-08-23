// Progression-formula config endpoints (System 2). The backend stores and
// resolves config only — all calculation happens on-device in the mobile
// registry. Resolution precedence lives in ONE place:
// data/progression.js getResolved() — the app never re-implements it.
const express = require('express');
const router = express.Router();
const progression = require('../data/progression');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assertReadableAssociation } = require('../data/assignedPlans');

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// Formula metadata for settings UIs — served from the shared formulas.json
// (kept in lockstep with the mobile registry; see that file's header).
router.get('/progression-formulas', requireAuth, async (req, res) => {
  try {
    res.json(progression.listFormulas());
  } catch (e) {
    httpError(res, e);
  }
});

// ── The user's OWN choice (self-service) ────────────────────────────────
router.get('/user/progression-settings', requireAuth, async (req, res) => {
  try {
    res.json(await progression.getUserSetting(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

router.put('/user/progression-settings', requireAuth, async (req, res) => {
  try {
    const { formula_key, params } = req.body || {};
    if (!formula_key) return res.status(400).json({ error: 'formula_key is required' });
    res.json(await progression.upsertUserSetting(req.user.id, formula_key, params || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

// ── THE endpoint the app calls: fully-resolved active setting ───────────
router.get('/client/progression-resolved', requireAuth, async (req, res) => {
  try {
    res.json(await progression.getResolved(req.user.id));
  } catch (e) {
    httpError(res, e);
  }
});

// ── Trainer per-client overrides ────────────────────────────────────────
router.get('/trainer/clients/:clientId/progression-override', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    await assertReadableAssociation(req.user.id, req.params.clientId);
    res.json(await progression.getOverride(req.user.id, req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});

router.put('/trainer/clients/:clientId/progression-override', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const { formula_key, params } = req.body || {};
    res.json(await progression.setOverride(req.user.id, req.params.clientId, formula_key, params || {}));
  } catch (e) {
    httpError(res, e, 400);
  }
});

router.delete('/trainer/clients/:clientId/progression-override', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    res.json(await progression.clearOverride(req.user.id, req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});

// Trainer's view of a client's RESOLVED progression setting — same
// resolution logic as /client/progression-resolved (one source of truth),
// authorized via the trainer-client association instead of self.
router.get('/trainer/clients/:clientId/progression-resolved', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    await assertReadableAssociation(req.user.id, req.params.clientId);
    res.json(await progression.getResolved(req.params.clientId));
  } catch (e) {
    httpError(res, e);
  }
});


module.exports = router;