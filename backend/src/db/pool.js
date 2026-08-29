// Single configured pg Pool. All connection info comes from DATABASE_URL;
// PGSSL toggles SSL for cloud providers that require it. Swapping local
// Postgres for Supabase/Railway/Neon is a .env change only.
require('dotenv').config();

const { Pool, types } = require('pg');

const useSsl = (process.env.PGSSL || 'false').toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// DATE columns (OID 1082) are CALENDAR DATES, not instants: diet log_date,
// check-in date, swap_date, target effective_from. pg's default parser
// converts them to a JS Date at SERVER-LOCAL midnight, which JSON
// serialization then renders in UTC — for any server timezone ahead of UTC
// (e.g. IST) every date-only value crossed the API as the PREVIOUS day and
// the client's fresh-install restore wrote shifted dates into SQLite
// (2026-08-29 → "2026-08-28T18:30:00.000Z" → 2026-08-28). Keep the raw
// 'YYYY-MM-DD' string so the logical date is byte-identical through
// Postgres → API → client. Timestamp columns (logged_at, created_at, …)
// are real instants and keep the default Date parsing.
types.setTypeParser(1082, (v) => v);

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
