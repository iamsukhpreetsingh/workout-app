// Data access for session_summaries — aggregate-only sync targets.
// All raw SQL for this table lives here, consistent with the other
// data-access modules.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Batch upsert on (client_id, local_session_id). client_id always comes from
// the authenticated user server-side — never from the request body.
async function upsertSummaries(clientId, summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new HttpError(400, 'Body must be a non-empty array of session summaries');
  }
  const rows = [];
  // one round-trip per summary keeps validation simple; batches are small
  for (const s of summaries) {
    if (!s || !s.local_session_id || !s.performed_at) {
      throw new HttpError(400, 'Each summary requires local_session_id and performed_at');
    }
    const { rows: r } = await query(
      `INSERT INTO session_summaries
         (client_id, local_session_id, name, performed_at, duration_seconds,
          exercise_count, working_set_count, total_volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (client_id, local_session_id) DO UPDATE SET
         name = EXCLUDED.name,
         performed_at = EXCLUDED.performed_at,
         duration_seconds = EXCLUDED.duration_seconds,
         exercise_count = EXCLUDED.exercise_count,
         working_set_count = EXCLUDED.working_set_count,
         total_volume = EXCLUDED.total_volume,
         synced_at = now()
       RETURNING *`,
      [
        clientId,
        String(s.local_session_id),
        s.name || null,
        s.performed_at,
        s.duration_seconds ?? null,
        s.exercise_count ?? 0,
        s.working_set_count ?? 0,
        s.total_volume ?? 0,
      ]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listForClient(clientId, { limit = 20, offset = 0, from, to } = {}) {
  const { rows } = await query(
    `SELECT * FROM session_summaries
     WHERE client_id = $1
       AND ($2::date IS NULL OR performed_at::date >= $2)
       AND ($3::date IS NULL OR performed_at::date <= $3)
     ORDER BY performed_at DESC
     LIMIT $4 OFFSET $5`,
    [clientId, from || null, to || null, limit, offset]
  );
  return rows;
}

// Roster with active + archived groups. Archived entries carry archived_at
// and days_remaining vs the stored purge_at; 'revoked' rows never appear.
async function rosterWithArchive(trainerId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, tc.status, tc.archived_at, tc.archived_by, tc.purge_at,
            GREATEST(0, EXTRACT(DAY FROM (tc.purge_at - now()))::int) AS days_remaining,
            last.last_active_at,
            ROUND(days.recent_day_count::numeric / 30 * 100, 1) AS adherence_pct
     FROM (
       -- one row per client: prefer the active association; otherwise the
       -- most recent archived one (repeated Start-Fresh cycles can leave
       -- several archived rows per pair)
       SELECT DISTINCT ON (client_id) *
       FROM trainer_clients
       WHERE trainer_id = $1 AND status IN ('active', 'archived')
       ORDER BY client_id,
                (status = 'active') DESC,
                archived_at DESC NULLS LAST,
                responded_at DESC NULLS LAST
     ) tc
     JOIN users u ON u.id = tc.client_id
     LEFT JOIN (
       SELECT client_id, MAX(performed_at) AS last_active_at
       FROM session_summaries GROUP BY client_id
     ) last ON last.client_id = u.id
     LEFT JOIN (
       SELECT client_id, COUNT(*) AS recent_day_count
       FROM (
         SELECT DISTINCT client_id, (performed_at AT TIME ZONE 'UTC')::date AS workout_day
         FROM session_summaries
         WHERE performed_at >= now() - interval '30 days'
       ) d
       GROUP BY client_id
     ) days ON days.client_id = u.id
     ORDER BY tc.status ASC, tc.responded_at DESC`,
    [trainerId]
  );
  return rows;
}

// Per-client aggregates for the trainer's client list, computed in ONE query
// (JOIN + GROUP BY — never N+1).
//
// ADHERENCE DEFINITION (used everywhere the number is shown):
//   adherence_pct = (number of DISTINCT calendar days in the trailing 30 days
//   that have at least one session_summaries row for that client) / 30 * 100,
//   rounded to one decimal. Calendar days are counted in the server's local
//   timezone. A day with multiple sessions counts once.
async function clientsWithActivity(trainerId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, tc.responded_at AS associated_at,
            last.last_active_at,
            -- distinct trailing-30-day workout days / 30, as a percentage
            ROUND(days.recent_day_count::numeric / 30 * 100, 1) AS adherence_pct
     FROM trainer_clients tc
     JOIN users u ON u.id = tc.client_id
     LEFT JOIN (
       SELECT client_id, MAX(performed_at) AS last_active_at
       FROM session_summaries
       GROUP BY client_id
     ) last ON last.client_id = u.id
     LEFT JOIN (
       SELECT client_id, COUNT(*) AS recent_day_count
       FROM (
         SELECT DISTINCT client_id,
                (performed_at AT TIME ZONE 'UTC')::date AS workout_day
         FROM session_summaries
         WHERE performed_at >= now() - interval '30 days'
       ) d
       GROUP BY client_id
     ) days ON days.client_id = u.id
     WHERE tc.trainer_id = $1 AND tc.status = 'active'
     ORDER BY tc.responded_at DESC`,
    [trainerId]
  );
  return rows;
}

module.exports = { upsertSummaries, rosterWithArchive, listForClient, clientsWithActivity };
