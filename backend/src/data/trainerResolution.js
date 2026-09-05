// trainerResolution.js — ONE resolver for "the user's active trainer".
//
// The product has two trainer relationships that must never contradict
// each other in the UI:
//
//   1. GYM-assigned  — gym_trainer_assignments (portal-managed, per gym
//      member row; the trainer is gym STAFF). Surfaced through
//      gymTrainers.listMyTrainers.
//   2. USER-connected — trainer_clients (invite-code relationship with a
//      platform trainer account; powers plans/photos/notifications).
//
// BUSINESS RULE (single-trainer product model — trainerClients already
// enforces one active platform relationship per client):
//
//   GYM-assigned trainer  >  USER-connected trainer  >  none
//
// The resolver NEVER mutates anything: when a gym assignment takes
// precedence, the user-connected relationship is preserved underneath
// (Case C — the gym later removing its assignment must fall back to it,
// Case D). Every surface that shows "the trainer" (Profile, My Gym) reads
// THIS resolution — server-authoritative, recomputed per request, so gym
// portal changes propagate on the next fetch (Case E stale cache).
const gymTrainers = require('./gymTrainers');
const trainerClients = require('./trainerClients');

// The user's gym-assigned trainer, or null. Rows without an assignment
// (trainer_name null) are skipped; ordering is deterministic (gyms by
// name — listMyTrainers) so multi-gym users always resolve to the SAME
// trainer on every call.
async function findGymAssignedTrainer(userId) {
  const rows = await gymTrainers.listMyTrainers(userId);
  const assigned = rows.filter((r) => r.trainer_name);
  if (!assigned.length) return null;
  const row = assigned[0];
  return {
    member_id: row.member_id,
    gym_id: row.gym_id,
    gym_name: row.gym_name,
    trainer_name: row.trainer_name,
    trainer_email: row.trainer_email,
    starts_on: row.starts_on || null,
    // the ACTIVE assignment row — lets the member-end their own assignment
    // (Settings → Disconnect) without a second lookup. listMyTrainers
    // already selects it; resolveActiveTrainer does NOT surface it.
    assignment_id: row.assignment_id || null,
  };
}

// The resolved active trainer. Always resolves to a full shape (never
// throws for "no trainer") so clients render one consistent contract:
//
//   { source: 'GYM'|'USER'|null,
//     status: 'active'|'pending'|null,
//     trainer: { name, email } | null,
//     gym: { id, name } | null,          // GYM source only
//     assigned_since: date | null,       // GYM source only
//     user_trainer: { name, status } | null }
//                                     // preserved USER relationship that
//                                     // is NOT the active one (gym wins)
async function resolveActiveTrainer(userId) {
  const [gymRow, platformState] = await Promise.all([
    findGymAssignedTrainer(userId),
    trainerClients.getAssociationStateForClient(userId),
  ]);

  if (gymRow) {
    return {
      source: 'GYM',
      status: 'active',
      trainer: { name: gymRow.trainer_name, email: gymRow.trainer_email || null },
      gym: { id: gymRow.gym_id, name: gymRow.gym_name },
      assigned_since: gymRow.starts_on,
      // Case C transparency: an invite-connected trainer stays on record
      // while the gym assignment is primary — shown as "also connected",
      // never as a competing primary trainer.
      user_trainer: platformState
        ? { name: platformState.trainer_name, status: platformState.status }
        : null,
    };
  }

  if (platformState && (platformState.status === 'active' || platformState.status === 'pending')) {
    return {
      source: 'USER',
      status: platformState.status,
      trainer: {
        name: platformState.trainer_name || null,
        email: platformState.trainer_email || null,
      },
      gym: null,
      assigned_since: null,
      user_trainer: null,
    };
  }

  return {
    source: null,
    status: null,
    trainer: null,
    gym: null,
    assigned_since: null,
    user_trainer: null,
  };
}

module.exports = { findGymAssignedTrainer, resolveActiveTrainer };
