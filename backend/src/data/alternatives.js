// Shared validation + persistence for configured exercise alternatives.
// Max 3 per exercise entry; an alternative may not duplicate the primary
// exercise or another alternative on the same entry (case-insensitive).
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_ALTERNATIVES = 3;

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// alternatives: array of names (strings) or {alternative_exercise_name}
// Returns cleaned [{ alternative_exercise_name, order_index }].
// Throws 400 on cap/duplicate violations — never silently truncates.
function normalizeAlternatives(primaryExerciseName, alternatives) {
  if (alternatives == null) return [];
  if (!Array.isArray(alternatives)) {
    throw new HttpError(400, 'alternatives must be an array of exercise names');
  }
  const clean = alternatives
    .map((a) => String(typeof a === 'string' ? a : a?.alternative_exercise_name || '').trim())
    .filter(Boolean);
  if (clean.length > MAX_ALTERNATIVES) {
    throw new HttpError(400, `Up to ${MAX_ALTERNATIVES} alternatives per exercise`);
  }
  const seen = new Set([norm(primaryExerciseName)]);
  for (const name of clean) {
    const key = norm(name);
    if (seen.has(key)) {
      throw new HttpError(
        400,
        name === primaryExerciseName
          ? `'${name}' is the primary exercise and cannot be its own alternative`
          : `'${name}' is already added as an alternative`
      );
    }
    seen.add(key);
  }
  return clean.map((name, i) => ({ alternative_exercise_name: name, order_index: i }));
}

async function insertForParent(client, column, parentId, alternatives) {
  for (const alt of alternatives) {
    await client.query(
      `INSERT INTO ${column} (${column === 'workout_template_exercise_alternatives' ? 'workout_template_exercise_id' : 'assigned_plan_exercise_id'}, alternative_exercise_name, order_index)
       VALUES ($1,$2,$3)`,
      [parentId, alt.alternative_exercise_name, alt.order_index]
    );
  }
}

// Fetch alternatives grouped by parent exercise id:
// { [parentExerciseId]: [names in order] }
async function fetchByParents(table, fkColumn, parentIds) {
  if (!parentIds.length) return {};
  const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT ${fkColumn} AS parent_id, alternative_exercise_name FROM ${table}
     WHERE ${fkColumn} IN (${placeholders}) ORDER BY order_index`,
    parentIds
  );
  const map = {};
  for (const r of rows) {
    (map[r.parent_id] = map[r.parent_id] || []).push(r.alternative_exercise_name);
  }
  return map;
}

module.exports = { normalizeAlternatives, insertForParent, fetchByParents, MAX_ALTERNATIVES };
