// Server-authoritative exercise catalog sync. The exercise picker renders
// from local SQLite, but its CONTENT now comes exclusively from the server
// catalog (GET /exercises/catalog) — bundled seed JSON is no longer the
// source. Sync is version-gated (meta endpoint) so the large payload only
// downloads when the server library actually changed.
//
// Safety rules:
//   - user custom exercises (is_custom = 1) are NEVER touched
//   - rows are matched case-insensitively by name so plan/session history
//     that references exercises keeps resolving to the same local ids
//   - global rows that disappeared server-side are marked is_archived=1
//     (hidden from pickers, never deleted — FKs stay valid)
//   - every failure is non-fatal: the app keeps rendering whatever cache
//     it already has
import * as SecureStore from 'expo-secure-store';
import { api } from './api';

const VERSION_KEY = 'exercise_catalog_version';

function getDb() {
  // lazy require avoids a circular import with db.js
  const { getDb } = require('../db/db');
  return getDb();
}

async function getLastCatalogVersion() {
  try {
    return await SecureStore.getItemAsync(VERSION_KEY);
  } catch {
    return null;
  }
}

async function setLastCatalogVersion(v) {
  try {
    await SecureStore.setItemAsync(VERSION_KEY, v);
  } catch {}
}

// Returns true if a full sync ran, false if skipped (unchanged / offline).
export async function syncExerciseCatalog({ force = false } = {}) {
  let meta;
  try {
    meta = await api('/exercises/catalog/meta');
  } catch {
    return false; // offline / server unreachable — keep current cache
  }

  const localVersion = await getLastCatalogVersion();
  if (!force && localVersion === meta.version) return false;

  const catalog = await api('/exercises/catalog');
  const db = await getDb();

  // Idempotent per-row upserts; the version marker is written only after
  // every row lands, so an interrupted sync simply retries next time.
  const serverNames = [];
  const seen = new Set();
  for (const ex of catalog.exercises || []) {
    if (!ex?.name) continue;
    const lower = String(ex.name).toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    serverNames.push(lower);
    const vals = [
      ex.muscle_group || 'Other',
      ex.body_part || null,
      ex.equipment || null,
      ex.target || null,
      JSON.stringify(ex.secondary_muscles || []),
      JSON.stringify(ex.instructions || {}),
      JSON.stringify(ex.instruction_steps || {}),
      ex.media_id || null,
      ex.gif_url || null,
      ex.attribution || null,
    ];
    // enrich existing global row matched case-insensitively by name;
    // custom rows are never overwritten
    await db.runAsync(
      `UPDATE exercises
          SET muscle_group = ?, body_part = ?, equipment = ?, target = ?,
              secondary_muscles = ?, instructions = ?, instruction_steps = ?,
              media_id = ?, gif_url = ?, attribution = ?,
              is_custom = 0, synced = 1, is_archived = 0
        WHERE lower(name) = ? AND is_custom = 0`,
      [...vals, lower]
    );
    await db.runAsync(
      `INSERT OR IGNORE INTO exercises
         (name, muscle_group, is_custom, body_part, equipment, target,
          secondary_muscles, instructions, instruction_steps,
          media_id, gif_url, attribution, synced)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [ex.name, ...vals]
    );
  }

  if (serverNames.length) {
    // hide globals that no longer exist server-side: mark instead of delete
    // (plans/sessions reference these row ids)
    await db.runAsync(
      `UPDATE exercises SET is_archived = 1
        WHERE is_custom = 0 AND lower(name) NOT IN (${serverNames.map(() => '?').join(',')})`,
      serverNames
    );
  }

  await setLastCatalogVersion(meta.version);
  return true;
}
