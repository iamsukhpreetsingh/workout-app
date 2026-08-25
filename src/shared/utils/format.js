// Shared date/volume formatting helpers. Previously these lived in
// src/theme.js or were copy-pasted across screens.

/**
 * Format a timestamp as e.g. "Mon, Aug 24, 2026".
 * @param {number|string|Date} ts
 * @returns {string}
 */
export const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

/**
 * Format a timestamp as e.g. "Aug 24".
 * @param {number|string|Date} ts
 * @returns {string}
 */
export const fmtShortDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Format a volume total compactly: "12.3k" above 1000, else rounded integer.
 * Null-safe — non-numeric input is treated as 0.
 * @param {number} v volume value
 * @returns {string}
 */
export function fmtVolume(v) {
  const n = Number(v) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
