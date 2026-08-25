/**
 * Pure helpers for the trainer-side client detail screen.
 * Extracted verbatim from ClientDetailScreen so they can be unit-tested
 * and reused without importing the screen.

/** @returns {string|null} compact duration like "1h 20m" or "45m" */
export function fmtDuration(sec) {
  if (!sec) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Human-friendly relative day label: Today / Yesterday / "N days ago" /
 * short date.
 * @param {string|number|Date|null} iso
 * @returns {string|null}
 */
export function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Local-date ISO string (YYYY-MM-DD) offset from today.
 * @param {number} [offsetDays]
 * @returns {string}
 */
export function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/**
 * Bucket session summaries into weekly volume totals (weeks start Monday),
 * sorted chronologically — chart-ready `{x, y}` points.
 * @param {Array<{performed_at: string, total_volume: number}>} summaries
 * @returns {Array<{x: number, y: number}>}
 */
export function weeklyVolumeBuckets(summaries) {
  const startOfWeek = (d) => {
    const date = new Date(d);
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const buckets = new Map();
  for (const s of summaries) {
    const key = startOfWeek(new Date(s.performed_at)).getTime();
    buckets.set(key, (buckets.get(key) || 0) + (Number(s.total_volume) || 0));
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

/** Short set-type tags used in per-set drill-down rows */
export const TYPE_TAG = { working: 'W', warmup: 'WU', dropset: 'DS', failure: 'F' };
