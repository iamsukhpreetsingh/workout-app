// Purge expired trainer-client archives. Run daily via cron:
//   0 3 * * * cd /path/to/backend && node scripts/purgeExpiredArchives.js
//
// Scope (deliberate): deletes TRAINER-OWNED content only — assigned_plans,
// and trainer-created diet_plans / supplement_plans (with cascading items
// and checkins). The client's own data (session_summaries,
// session_exercise_details, measurement_entries, self-authored plans) is
// NEVER touched. Idempotent: already-revoked rows are skipped.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { pool } = require('../src/db/pool');

async function purge() {
  // NOTE: the status='archived' filter intentionally EXCLUDES rows in
  // 'pending' — a pending reactivation request (Phase 4) moved the row out
  // of 'archived', so it is NEVER purged while awaiting the trainer's
  // decision, even if its stored purge_at has already passed. Do NOT
  // "fix" this by loosening the status filter to include 'pending'.
  const { rows } = await pool.query(
    `SELECT id, trainer_id, client_id FROM trainer_clients
     WHERE status = 'archived' AND purge_at < now()`
  );

  for (const rel of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const counts = {};

      const assigned = await client.query(
        `DELETE FROM assigned_plans WHERE trainer_id = $1 AND client_id = $2`,
        [rel.trainer_id, rel.client_id]
      );
      counts.assigned_plans = assigned.rowCount;

      const diet = await client.query(
        `DELETE FROM diet_plans
         WHERE trainer_id = $1 AND client_id = $2 AND created_by = 'trainer'`,
        [rel.trainer_id, rel.client_id]
      );
      counts.diet_plans = diet.rowCount;

      const supp = await client.query(
        `DELETE FROM supplement_plans
         WHERE trainer_id = $1 AND client_id = $2 AND created_by = 'trainer'`,
        [rel.trainer_id, rel.client_id]
      );
      counts.supplement_plans = supp.rowCount;

      await client.query(
        `UPDATE trainer_clients SET
           status = 'revoked', archived_at = NULL, purge_at = NULL,
           restore_preference = NULL
         WHERE id = $1 AND status = 'archived'`,
        [rel.id]
      );

      await client.query('COMMIT');
      // audit line: relationship + counts only, never content
      console.log(
        `purged relationship ${rel.id}:`,
        JSON.stringify(counts)
      );
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED relationship ${rel.id}:`, e.message);
    } finally {
      client.release();
    }
  }

  if (!rows.length) console.log('nothing to purge');
  return { relationships: rows.length };
}

// Log the run for the admin dashboard's health screen (best-effort).
async function purgeWithLog() {
  let result;
  try {
    result = await purge();
  } catch (e) {
    await pool.query(
      'INSERT INTO purge_job_runs (rows_purged, relationships_purged, errors) VALUES (0, 0, $1)',
      [e.message]
    ).catch(() => {});
    throw e;
  }
  await pool.query(
    'INSERT INTO purge_job_runs (rows_purged, relationships_purged) VALUES ($1, $2)',
    [result.rows || 0, result.relationships || 0]
  ).catch(() => {});
  return result;
}

// The admin dashboard's "Run purge job now" reuses THIS exact code path —
// never a divergent copy.
module.exports = { purge, runPurge: purgeWithLog };

if (require.main === module) {
  purgeWithLog()
    .then((r) => { console.log('purge complete:', JSON.stringify(r)); })
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => pool.end());
}
