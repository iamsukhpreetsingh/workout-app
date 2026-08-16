// Data access for users + refresh tokens. All raw SQL for these entities
// lives here — routes/controllers never query pg directly.
const { query } = require('../db/pool');

const PUBLIC_COLUMNS = 'id, email, name, role, created_at, updated_at'; // never password_hash

async function createUser({ email, passwordHash, name, role }) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)
     RETURNING ${PUBLIC_COLUMNS}`,
    [email.toLowerCase(), passwordHash, name, role]
  );
  return rows[0];
}

async function getUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function storeRefreshToken(userId, token, expiresAt) {
  await query(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
}

async function findValidRefreshToken(token) {
  const { rows } = await query(
    `SELECT * FROM refresh_tokens
     WHERE token = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [token]
  );
  return rows[0] || null;
}

async function revokeRefreshToken(token) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL', [token]);
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  storeRefreshToken,
  findValidRefreshToken,
  revokeRefreshToken,
};
