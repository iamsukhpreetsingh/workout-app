// Versioned SQL migration runner. Tracks applied files in schema_migrations;
// safe to re-run (second run applies nothing). Each file runs in a
// transaction so a failed migration leaves no partial state.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
      count++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('FAILED', file, e.message);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
  if (count === 0 && !process.exitCode) console.log('nothing to migrate');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
