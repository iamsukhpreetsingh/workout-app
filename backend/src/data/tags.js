// Data access for trainer tags
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Seed default tags for a trainer (called on first login)
async function seedDefaultTags(trainerId) {
  await query('SELECT seed_default_workout_tags($1)', [trainerId]);
  await query('SELECT seed_default_recipe_tags($1)', [trainerId]);
}

// Get all tags for a trainer, grouped by category
async function getTagsForTrainer(trainerId, category = null) {
  const result = category
    ? await query(
        'SELECT * FROM trainer_tags WHERE trainer_id = $1 AND category = $2 ORDER BY is_default DESC, name ASC',
        [trainerId, category]
      )
    : await query(
        'SELECT * FROM trainer_tags WHERE trainer_id = $1 ORDER BY category, is_default DESC, name ASC',
        [trainerId]
      );
  return result.rows;
}

// Get workout tags only
async function getWorkoutTags(trainerId) {
  return getTagsForTrainer(trainerId, 'workout');
}

// Get recipe tags only
async function getRecipeTags(trainerId) {
  return getTagsForTrainer(trainerId, 'recipe');
}

// Create a new custom tag
async function createTag(trainerId, name, category) {
  const normalizedName = String(name).trim();
  if (!normalizedName) {
    throw new HttpError(400, 'Tag name is required');
  }
  if (!['workout', 'recipe'].includes(category)) {
    throw new HttpError(400, 'Category must be workout or recipe');
  }

  // Check if tag already exists
  const existing = await query(
    'SELECT id FROM trainer_tags WHERE trainer_id = $1 AND LOWER(name) = LOWER($2) AND category = $3',
    [trainerId, normalizedName, category]
  );
  if (existing.rows.length > 0) {
    throw new HttpError(409, 'Tag already exists');
  }

  const result = await query(
    'INSERT INTO trainer_tags (trainer_id, name, category, is_default) VALUES ($1, $2, $3, false) RETURNING *',
    [trainerId, normalizedName, category]
  );
  return result.rows[0];
}

// Update a tag (only custom tags, not defaults)
async function updateTag(trainerId, tagId, name) {
  const normalizedName = String(name).trim();
  if (!normalizedName) {
    throw new HttpError(400, 'Tag name is required');
  }

  // Only allow updating custom tags
  const existing = await query(
    'SELECT * FROM trainer_tags WHERE id = $1 AND trainer_id = $2',
    [tagId, trainerId]
  );
  if (!existing.rows.length) {
    throw new HttpError(404, 'Tag not found');
  }
  if (existing.rows[0].is_default) {
    throw new HttpError(400, 'Cannot modify default tags');
  }

  // Check if new name conflicts with existing tag
  const conflict = await query(
    'SELECT id FROM trainer_tags WHERE trainer_id = $1 AND LOWER(name) = LOWER($2) AND category = $3 AND id != $4',
    [trainerId, normalizedName, existing.rows[0].category, tagId]
  );
  if (conflict.rows.length > 0) {
    throw new HttpError(409, 'Tag with this name already exists');
  }

  const result = await query(
    'UPDATE trainer_tags SET name = $3 WHERE id = $1 AND trainer_id = $2 RETURNING *',
    [tagId, trainerId, normalizedName]
  );
  return result.rows[0];
}

// Delete a tag (only custom tags, not defaults)
async function deleteTag(trainerId, tagId) {
  // Only allow deleting custom tags
  const existing = await query(
    'SELECT * FROM trainer_tags WHERE id = $1 AND trainer_id = $2',
    [tagId, trainerId]
  );
  if (!existing.rows.length) {
    throw new HttpError(404, 'Tag not found');
  }
  if (existing.rows[0].is_default) {
    throw new HttpError(400, 'Cannot delete default tags');
  }

  await query('DELETE FROM trainer_tags WHERE id = $1 AND trainer_id = $2', [tagId, trainerId]);
  return { ok: true };
}

// Check if tag is in use by any workout template
async function isTagInUseInWorkouts(trainerId, tagName) {
  const result = await query(
    `SELECT COUNT(*)::int as count FROM workout_templates 
     WHERE trainer_id = $1 AND $2 = ANY(tags)`,
    [trainerId, tagName]
  );
  return result.rows[0].count > 0;
}

// Check if tag is in use by any meal catalog item
async function isTagInUseInRecipes(trainerId, tagName) {
  const result = await query(
    `SELECT COUNT(*)::int as count FROM meal_catalog_items 
     WHERE trainer_id = $1 AND $2 = ANY(tags)`,
    [trainerId, tagName]
  );
  return result.rows[0].count > 0;
}

// Check if tag is in use anywhere
async function isTagInUse(trainerId, tagId) {
  const tag = await query('SELECT * FROM trainer_tags WHERE id = $1 AND trainer_id = $2', [tagId, trainerId]);
  if (!tag.rows.length) return false;

  const tagName = tag.rows[0].name;
  const category = tag.rows[0].category;

  if (category === 'workout') {
    return isTagInUseInWorkouts(trainerId, tagName);
  } else {
    return isTagInUseInRecipes(trainerId, tagName);
  }
}

module.exports = {
  seedDefaultTags,
  getTagsForTrainer,
  getWorkoutTags,
  getRecipeTags,
  createTag,
  updateTag,
  deleteTag,
  isTagInUse,
};