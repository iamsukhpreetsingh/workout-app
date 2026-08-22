// Offline cache helper for trainer-assigned (server-owned) content.
// Fetch-through cache: success writes the payload into sync_cache; failure
// falls back to the cached copy so trainer content stays visible offline.
// One-way by design — cached trainer data is NEVER uploaded anywhere.
import { getDb } from '../db/db';
import { getCurrentUserId } from '../db/userId';

export async function fetchAndCacheTrainerContent(cacheKey, fetcher) {
  try {
    const data = await fetcher();
    try {
      const db = await getDb();
      const userId = getCurrentUserId();
      if (userId) {
        await db.runAsync(
          `INSERT OR REPLACE INTO sync_cache (user_id, cache_key, payload, last_fetched_at)
           VALUES (?,?,?,?)`,
          [userId, cacheKey, JSON.stringify(data), Date.now()]);
      }
    } catch {}
    return data;
  } catch (e) {
    try {
      const db = await getDb();
      const userId = getCurrentUserId();
      if (userId) {
        const row = await db.getFirstAsync(
          'SELECT payload FROM sync_cache WHERE user_id = ? AND cache_key = ?',
          [userId, cacheKey]);
        if (row?.payload) return JSON.parse(row.payload);
      }
    } catch {}
    throw e;
  }
}