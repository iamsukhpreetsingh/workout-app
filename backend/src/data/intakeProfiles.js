// Data access for client intake profiles (health context — sensitive).
// ONE profile per client, shared across all their trainers: allergens
// drive the trainer-side conflict warnings; goals / injuries /
// medical_conditions are display-only builder context. A missing profile
// (null) means the app skips ALL allergen checking — never an error.
// Never include this data in notification bodies or logs.
const { query } = require('../db/pool');

// Fetch the client's profile row, or null when none exists. Used by both
// the client (own profile) and trainer (read-only) routes — access control
// lives in the routes (requireRole + association checks).
async function getProfileForClient(clientId) {
  const { rows } = await query(
    'SELECT * FROM client_intake_profiles WHERE client_user_id = $1',
    [clientId]
  );
  return rows[0] || null;
}

// Create or replace the client's own profile. Used by BOTH the onboarding
// gate and later settings edits (same form component, same endpoint).
// completed_at is stamped on every successful save — that timestamp is
// what switches on the trainer-side allergen warnings.
async function upsertProfile(clientId, { allergens, goals, injuries, medical_conditions }) {
  const { rows } = await query(
    `INSERT INTO client_intake_profiles
       (client_user_id, allergens, goals, injuries, medical_conditions, completed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (client_user_id) DO UPDATE SET
       allergens = EXCLUDED.allergens,
       goals = EXCLUDED.goals,
       injuries = EXCLUDED.injuries,
       medical_conditions = EXCLUDED.medical_conditions,
       completed_at = now(),
       updated_at = now()
     RETURNING *`,
    [clientId, allergens, goals, injuries || null, medical_conditions || null]
  );
  return rows[0];
}

module.exports = { getProfileForClient, upsertProfile };