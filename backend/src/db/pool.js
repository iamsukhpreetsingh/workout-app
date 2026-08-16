// Single configured pg Pool. All connection info comes from DATABASE_URL;
// PGSSL toggles SSL for cloud providers that require it. Swapping local
// Postgres for Supabase/Railway/Neon is a .env change only.
require('dotenv').config();

const { Pool } = require('pg');

const useSsl = (process.env.PGSSL || 'false').toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// Thin query() wrapper so modules never import pg directly.
async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };
