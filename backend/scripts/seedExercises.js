#!/usr/bin/env node
// Seed the global exercise library (exercises table) from the mobile app's
// seed file. Idempotent: re-runs upsert existing ids. Run after migrations:
//   npm run seed-exercises
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const SEED_FILE = path.resolve(__dirname, '../../src/seed/exercises_full.json');

async function main() {
  const exercises = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (!Array.isArray(exercises) || !exercises.length) {
    console.error('seedExercises: no exercises found in', SEED_FILE);
    process.exit(1);
  }

  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query('BEGIN');
    for (const e of exercises) {
      if (!e.id || !e.name) continue;
      await client.query(
        `INSERT INTO exercises (id, name, category, body_part, equipment, muscle_group,
           secondary_muscles, target, instructions, instruction_steps, image, gif_url,
           media_id, attribution, is_official)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           body_part = EXCLUDED.body_part,
           equipment = EXCLUDED.equipment,
           muscle_group = EXCLUDED.muscle_group,
           secondary_muscles = EXCLUDED.secondary_muscles,
           target = EXCLUDED.target,
           instructions = EXCLUDED.instructions,
           instruction_steps = EXCLUDED.instruction_steps,
           image = EXCLUDED.image,
           gif_url = EXCLUDED.gif_url,
           media_id = EXCLUDED.media_id,
           attribution = EXCLUDED.attribution`,
        [
          e.id, e.name, e.category || null, e.body_part || null, e.equipment || null,
          e.muscle_group || null, JSON.stringify(e.secondary_muscles || []), e.target || null,
          JSON.stringify(e.instructions || {}), JSON.stringify(e.instruction_steps || {}),
          e.image || null, e.gif_url || null, e.media_id || null, e.attribution || null,
        ]
      );
      upserted++;
    }
    await client.query('COMMIT');
    console.log(`seedExercises: ${upserted} exercises upserted`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
