// structureSuggestions.js — advisory meal-shape guidance (Phase 5).
// Suggestions are free-text ideas (optionally pointing at a recipe) attached
// to a user by their trainer or inherited from an old plan. They NEVER gate,
// block, or affect target-status calculation — they're display-only guidance
// the client can collapse or disable entirely.
const { query, transaction } = require('../db/pool');
const coaching = require('./coachingPlans');
const { assertActiveAssociation } = require('./assignedPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

async function getStructureSuggestions(userId) {
  const { rows } = await query(
    `SELECT * FROM structure_suggestions WHERE user_id = $1 ORDER BY order_index`,
    [userId]
  );
  return rows;
}

// Trainer sets/replaces the client's suggestion list in one call.
async function setStructureSuggestions(trainerId, clientId, suggestions) {
  await assertActiveAssociation(trainerId, clientId);
  if (!Array.isArray(suggestions)) throw new HttpError(400, 'suggestions must be an array');
  return transaction(async (client) => {
    await client.query('DELETE FROM structure_suggestions WHERE user_id = $1', [clientId]);
    let i = 0;
    for (const s of suggestions) {
      if (!s?.suggestion_text) continue;
      await client.query(
        `INSERT INTO structure_suggestions (user_id, meal_type, suggestion_text, suggested_recipe_id, created_by, order_index)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, MEAL_TYPES.includes(s.meal_type) ? s.meal_type : 'other',
         String(s.suggestion_text).slice(0, 500), s.suggested_recipe_id || null, trainerId, i++]
      );
    }
    const { rows } = await client.query(
      'SELECT * FROM structure_suggestions WHERE user_id = $1 ORDER BY order_index',
      [clientId]
    );
    return rows;
  });
}

// A user may manage their own suggestions too (self-guidance).
async function setSelfSuggestions(userId, suggestions) {
  return setStructureSuggestions(userId, userId, suggestions);
}

module.exports = { getStructureSuggestions, setStructureSuggestions, setSelfSuggestions };
