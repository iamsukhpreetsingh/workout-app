const express = require('express');
const tags = require('../data/tags');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function httpError(res, e, fallback = 500) {
  res.status(e.status || fallback).json({ error: e.message || 'Unexpected error' });
}

// GET /trainer/tags — get all tags for trainer (grouped by category)
router.get('/tags', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const category = req.query.category; // optional filter
    const allTags = await tags.getTagsForTrainer(req.user.id, category || null);
    
    // Group by category
    const grouped = {
      workout: allTags.filter(t => t.category === 'workout'),
      recipe: allTags.filter(t => t.category === 'recipe'),
    };
    res.json(grouped);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/tags/workout — workout tags only
router.get('/tags/workout', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const result = await tags.getWorkoutTags(req.user.id);
    res.json(result);
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/tags/recipe — recipe tags only
router.get('/tags/recipe', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const result = await tags.getRecipeTags(req.user.id);
    res.json(result);
  } catch (e) {
    httpError(res, e);
  }
});

// POST /trainer/tags — create custom tag
router.post('/tags', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const { name, category } = req.body || {};
    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }
    const tag = await tags.createTag(req.user.id, name, category);
    res.status(201).json(tag);
  } catch (e) {
    httpError(res, e);
  }
});

// PATCH /trainer/tags/:id — rename custom tag
router.patch('/tags/:id', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const tag = await tags.updateTag(req.user.id, req.params.id, name);
    res.json(tag);
  } catch (e) {
    httpError(res, e);
  }
});

// DELETE /trainer/tags/:id — delete custom tag (only if not in use)
router.delete('/tags/:id', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    // First check if tag is in use
    const inUse = await tags.isTagInUse(req.user.id, req.params.id);
    if (inUse) {
      return res.status(400).json({ error: 'Cannot delete tag that is in use. Remove it from all items first.' });
    }
    await tags.deleteTag(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, e);
  }
});

// GET /trainer/tags/:id/in-use — check if tag is in use
router.get('/tags/:id/in-use', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    const inUse = await tags.isTagInUse(req.user.id, req.params.id);
    res.json({ in_use: inUse });
  } catch (e) {
    httpError(res, e);
  }
});

// POST /trainer/tags/seed — seed default tags (helper for initial setup)
router.post('/tags/seed', requireAuth, requireRole('trainer'), async (req, res) => {
  try {
    await tags.seedDefaultTags(req.user.id);
    const allTags = await tags.getTagsForTrainer(req.user.id);
    res.json({ ok: true, count: allTags.length });
  } catch (e) {
    httpError(res, e);
  }
});

module.exports = router;