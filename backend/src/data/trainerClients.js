// Data access for trainer-client associations and invite codes.
// Application-level role checks live here so they can't be bypassed by
// callers forgetting to validate.
const { query } = require('../db/pool');
const { getUserById } = require('./users');
const coachingPlans = require('./coachingPlans');
const assignedPlans = require('./assignedPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function createInviteCode(trainerId, code, expiresAt) {
  const trainer = await getUserById(trainerId);
  if (!trainer || trainer.role !== 'trainer') {
    throw new HttpError(403, 'Only trainer accounts can generate invite codes');
  }
  const { rows } = await query(
    `INSERT INTO trainer_invite_codes (trainer_id, code, expires_at)
     VALUES ($1, $2, $3) RETURNING id, code, expires_at`,
    [trainerId, code, expiresAt]
  );
  return rows[0];
}

async function findValidInviteCode(code) {
  const { rows } = await query(
    `SELECT c.*, u.name AS trainer_name FROM trainer_invite_codes c
     JOIN users u ON u.id = c.trainer_id
     WHERE c.code = $1 AND c.expires_at > now() AND c.used_at IS NULL`,
    [code]
  );
  return rows[0] || null;
}

// Codes are single-use: atomically claim (burn) a code. Returns false if
// another request already redeemed it — the WHERE guard makes this
// race-safe even under concurrent redemptions.
async function claimInviteCode(codeId) {
  const { rows } = await query(
    `UPDATE trainer_invite_codes SET used_at = now()
     WHERE id = $1 AND used_at IS NULL
     RETURNING id`,
    [codeId]
  );
  return rows.length > 0;
}

// GET /client/trainer-code-preview support: look up the invite code's
// trainer and check for a still-archived (not purged, not pending)
// relationship with this client.
async function trainerCodePreview(clientId, code) {
  const invite = await findValidInviteCode(code);
  if (!invite) throw new HttpError(400, 'Invalid or expired invite code');
  const { rows } = await query(
    `SELECT * FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status = 'archived'
     LIMIT 1`,
    [invite.trainer_id, clientId]
  );
  const archived = rows[0] || null;
  let counts = null;
  if (archived) {
    const [assigned, diet] = await Promise.all([
      query(
        `SELECT COUNT(*) AS c FROM assigned_plans
         WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'`,
        [archived.trainer_id, clientId]
      ),
      query(
        `SELECT COUNT(*) AS c FROM diet_plans
         WHERE trainer_id = $1 AND client_id = $2 AND status = 'active' AND created_by = 'trainer'`,
        [archived.trainer_id, clientId]
      ),
    ]);
    counts = {
      assigned_workouts: Number(assigned.rows[0].c),
      diet_plans: Number(diet.rows[0].c),
    };
  }
  return {
    trainer_id: invite.trainer_id,
    trainer_name: invite.trainer_name,
    is_reactivation: !!archived,
    archived_at: archived?.archived_at || null,
    purge_at: archived?.purge_at || null,
    counts,
  };
}

// Client submits a trainer's invite code → pending association
async function requestAssociationByCode(clientId, code, restorePreference = null) {
  const client = await getUserById(clientId);
  if (!client || client.role !== 'user') {
    throw new HttpError(403, 'Only user (client) accounts can request association');
  }
  const invite = await findValidInviteCode(code);
  if (!invite) throw new HttpError(400, 'Invalid or expired invite code');

  // Idempotency / business rules — one pending request, one active trainer.
  // NOTE: 'archived' rows are EXCLUDED here on purpose — they're handled by
  // the reactivation branch below (reuse the row with a preference).
  const withTrainer = await query(
    `SELECT * FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status IN ('pending', 'active')`,
    [invite.trainer_id, clientId]
  );
  if (withTrainer.rows.length) {
    if (withTrainer.rows[0].status === 'pending') {
      throw new HttpError(409, 'Request already pending with this trainer');
    }
    throw new HttpError(409, 'Already connected to this trainer');
  }

  const otherActive = await query(
    `SELECT 1 FROM trainer_clients
     WHERE client_id = $1 AND status = 'active'`,
    [clientId]
  );
  if (otherActive.rows.length) {
    // One trainer per client — never silently replace the existing relationship
    throw new HttpError(409, 'You already have an active trainer');
  }

  // claim BEFORE inserting so concurrent redemptions of the same code
  // can't both succeed
  const claimed = await claimInviteCode(invite.id);
  if (!claimed) {
    throw new HttpError(409, 'This invite code has already been used');
  }
  // Reactivation: REUSE the archived row (keeps archived_at/purge_at for a
  // decline or 'fresh' outcome) instead of inserting a new one. Multiple
  // archived rows can exist after repeated Start-Fresh cycles — always take
  // the most recent.
  const archived = await query(
    `SELECT id FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status = 'archived'
     ORDER BY archived_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [invite.trainer_id, clientId]
  );
  if (archived.rows.length) {
    const pref = restorePreference === 'fresh' || restorePreference === 'restore'
      ? restorePreference
      : null;
    if (!pref) {
      throw new HttpError(400, 'restore_preference is required when reconnecting with a previously archived trainer');
    }
    const { rows } = await query(
      `UPDATE trainer_clients SET
         status = 'pending', requested_by = 'client', responded_at = NULL,
         restore_preference = $3
       WHERE id = $1 AND trainer_id = $2
       RETURNING trainer_clients.*, $4::text AS trainer_name`,
      [archived.rows[0].id, invite.trainer_id, pref, invite.trainer_name]
    );
    return rows[0];
  }

  const { rows } = await query(
    `INSERT INTO trainer_clients (trainer_id, client_id, status, requested_by)
     VALUES ($1, $2, 'pending', 'client')
     RETURNING trainer_clients.*, $3::text AS trainer_name`,
    [invite.trainer_id, clientId, invite.trainer_name]
  );
  return rows[0];
}

// The client's current association state: active trainer, or a pending
// request awaiting the trainer's response. Rejected requests are revoked
// and simply don't appear.
async function getAssociationStateForClient(clientId) {
  const { rows } = await query(
    `SELECT tc.status, tc.responded_at,
            u.id AS trainer_id, u.name AS trainer_name, u.email AS trainer_email
     FROM trainer_clients tc JOIN users u ON u.id = tc.trainer_id
     WHERE tc.client_id = $1 AND tc.status != 'revoked'
     -- prefer an open association over stale archived rows left by
     -- Start-Fresh cycles
     ORDER BY (tc.status IN ('pending', 'active')) DESC, tc.created_at DESC
     LIMIT 1`,
    [clientId]
  );
  if (!rows.length) return null;
  return rows[0];
}

async function listAssociations(trainerId, status) {
  const { rows } = await query(
    `SELECT tc.*, u.name AS client_name, u.email AS client_email
     FROM trainer_clients tc JOIN users u ON u.id = tc.client_id
     WHERE tc.trainer_id = $1 AND ($2::text IS NULL OR tc.status = $2)
     ORDER BY tc.created_at DESC`,
    [trainerId, status || null]
  );
  // flag reactivations + attach the archived-history summary
  for (const r of rows) {
    r.is_reactivation = r.restore_preference != null;
    if (r.is_reactivation) {
      const [assigned, diet] = await Promise.all([
        query(
          `SELECT COUNT(*) AS c FROM assigned_plans
           WHERE trainer_id = $1 AND client_id = $2 AND status = 'active'`,
          [trainerId, r.client_id]
        ),
        query(
          `SELECT COUNT(*) AS c FROM diet_plans
           WHERE trainer_id = $1 AND client_id = $2 AND status = 'active' AND created_by = 'trainer'`,
          [trainerId, r.client_id]
        ),
      ]);
      r.archived_summary = {
        assigned_workouts: Number(assigned.rows[0].c),
        diet_plans: Number(diet.rows[0].c),
      };
    }
  }
  return rows;
}

async function respondToAssociation(trainerId, associationId, action, finalDecision = null) {
  const existing = await query(
    'SELECT * FROM trainer_clients WHERE id = $1 AND trainer_id = $2',
    [associationId, trainerId]
  );
  if (!existing.rows.length) throw new HttpError(404, 'Association not found');
  const row = existing.rows[0];
  const isReactivation = row.restore_preference != null;

  if (action === 'accept') {
    if (isReactivation) {
      const decision = finalDecision === 'restore' || finalDecision === 'fresh' ? finalDecision : null;
      if (!decision) {
        throw new HttpError(400, "final_decision ('restore' or 'fresh') is required for reactivation requests");
      }
      if (decision === 'restore') {
        const { rows } = await query(
          `UPDATE trainer_clients SET
             status = 'active', responded_at = now(),
             archived_at = NULL, archived_by = NULL, purge_at = NULL,
             restore_preference = NULL
           WHERE id = $1 RETURNING *`,
          [associationId]
        );
        return rows[0];
      }
      // fresh: separate clean row; the archived row keeps its own countdown
      // First archive ALL historical data for this trainer-client pair
      await coachingPlans.archiveAllPlansForPair('diet', trainerId, row.client_id);
      await coachingPlans.archiveAllPlansForPair('supplement', trainerId, row.client_id);
      await assignedPlans.archiveAllAssignedPlansForPair(trainerId, row.client_id);
      
      await query(
        `UPDATE trainer_clients SET status = 'archived', responded_at = now()
         WHERE id = $1`,
        [associationId]
      );
      const { rows } = await query(
        `INSERT INTO trainer_clients (trainer_id, client_id, status, requested_by, responded_at)
         VALUES ($1, $2, 'active', 'client', now()) RETURNING *`,
        [trainerId, row.client_id]
      );
      return rows[0];
    }
    const { rows } = await query(
      `UPDATE trainer_clients SET status = 'active', responded_at = now()
       WHERE id = $1 RETURNING *`,
      [associationId]
    );
    return rows[0];
  }

  // reject
  if (isReactivation) {
    // decline = "not now": revert to archived, original countdown intact
    const { rows } = await query(
      `UPDATE trainer_clients SET
         status = 'archived', responded_at = now(), restore_preference = NULL
       WHERE id = $1 RETURNING *`,
      [associationId]
    );
    return rows[0];
  }
  const { rows } = await query(
    `UPDATE trainer_clients SET status = 'revoked', responded_at = now()
     WHERE id = $1 RETURNING *`,
    [associationId]
  );
  return rows[0];
}
async function listActiveClients(trainerId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, tc.responded_at AS associated_at
     FROM trainer_clients tc JOIN users u ON u.id = tc.client_id
     WHERE tc.trainer_id = $1 AND tc.status = 'active'
     ORDER BY tc.responded_at DESC`,
    [trainerId]
  );
  return rows;
}

async function getActiveTrainerForClient(clientId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, tc.responded_at AS associated_at
     FROM trainer_clients tc JOIN users u ON u.id = tc.trainer_id
     WHERE tc.client_id = $1 AND tc.status = 'active'
     ORDER BY tc.responded_at DESC LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

module.exports = {
  createInviteCode,
  trainerCodePreview,
  getAssociationStateForClient,
  requestAssociationByCode,
  listAssociations,
  respondToAssociation,
  listActiveClients,
  getActiveTrainerForClient,
};
