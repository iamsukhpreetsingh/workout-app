// Data access for trainer-client associations and invite codes.
// Application-level role checks live here so they can't be bypassed by
// callers forgetting to validate.
const { query } = require('../db/pool');
const { getUserById } = require('./users');

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

// Client submits a trainer's invite code → pending association
async function requestAssociationByCode(clientId, code) {
  const client = await getUserById(clientId);
  if (!client || client.role !== 'user') {
    throw new HttpError(403, 'Only user (client) accounts can request association');
  }
  const invite = await findValidInviteCode(code);
  if (!invite) throw new HttpError(400, 'Invalid or expired invite code');

  // Idempotency / business rules — one pending request, one active trainer.
  const withTrainer = await query(
    `SELECT * FROM trainer_clients
     WHERE trainer_id = $1 AND client_id = $2 AND status != 'revoked'`,
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
     ORDER BY tc.created_at DESC LIMIT 1`,
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
  return rows;
}

async function respondToAssociation(trainerId, associationId, newStatus) {
  // newStatus: 'active' (accept) or 'revoked' (reject/revoke)
  const { rows } = await query(
    `UPDATE trainer_clients
     SET status = $3, responded_at = now()
     WHERE id = $1 AND trainer_id = $2
     RETURNING *`,
    [associationId, trainerId, newStatus]
  );
  if (!rows.length) throw new HttpError(404, 'Association not found');
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
  getAssociationStateForClient,
  requestAssociationByCode,
  listAssociations,
  respondToAssociation,
  listActiveClients,
  getActiveTrainerForClient,
};
