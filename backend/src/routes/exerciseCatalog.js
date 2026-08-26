// Global exercise catalog for the mobile app. The app renders this list
// from the SERVER: it fetches /exercises/catalog/meta to detect changes and
// /exercises/catalog for the full dataset, upserting into its local SQLite
// cache (which stays the offline render source). Archived exercises are
// excluded; user custom exercises are NOT served here (separate scope).
const express = require('express');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { registerRoute } = require('../admin/registry');

const router = express.Router();

// Same category→muscle-group mapping the app applied to its old local seed,
// so server rows land with identical grouping values.
const CAT_TO_GROUP = {
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders',
  'upper arms': 'Arms', 'lower arms': 'Arms', arms: 'Arms',
  'upper legs': 'Legs', 'lower legs': 'Legs', legs: 'Legs',
  waist: 'Core', cardio: 'Cardio', neck: 'Shoulders',
};

function mapRow(r) {
  return {
    name: r.name,
    muscle_group: CAT_TO_GROUP[String(r.category || '').toLowerCase()] || r.muscle_group || 'Other',
    body_part: r.body_part || null,
    equipment: r.equipment || null,
    target: r.target || null,
    secondary_muscles: r.secondary_muscles || [],
    instructions: r.instructions || {},
    instruction_steps: r.instruction_steps || {},
    media_id: r.media_id || null,
    gif_url: r.gif_url || null,
    attribution: r.attribution || null,
  };
}

// GET /exercises/catalog/meta — cheap change-detection for the device
registerRoute(
  router,
  {
    method: 'GET',
    path: '/catalog/meta',
    description: 'Exercise catalog version (count + latest updated_at) so devices only re-download when the library changed.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Workouts',
  },
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT count(*)::int AS count,
                coalesce(max(updated_at)::text, 'none') AS last_update
         FROM exercises WHERE NOT is_archived`
      );
      res.json({
        count: rows[0].count,
        version: `${rows[0].count}:${rows[0].last_update}`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
  requireAuth
);

// GET /exercises/catalog — the full global library (non-archived)
registerRoute(
  router,
  {
    method: 'GET',
    path: '/catalog',
    description: 'Full global exercise library for the app\'s local cache. Excludes archived exercises; custom exercises are user-scoped and not included.',
    requiresAuth: true,
    allowedRoles: ['user', 'trainer'],
    category: 'Workouts',
  },
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT name, category, muscle_group, body_part, equipment, target,
                secondary_muscles, instructions, instruction_steps,
                media_id, gif_url, attribution
         FROM exercises WHERE NOT is_archived ORDER BY name`
      );
      res.json({ count: rows.length, exercises: rows.map(mapRow) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
  requireAuth
);

module.exports = router;
