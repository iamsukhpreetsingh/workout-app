// Pure streak math operating on LOCAL calendar dates (YYYY-MM-DD strings),
// so a workout at 11pm and another at 1am land on the correct day regardless
// of timezone or DST shifts. All comparisons use calendar-day indexes
// computed from local midnight Dates, never raw millisecond diffs.

export function toLocalDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Days between two local date keys (b - a), DST-safe: both are normalized
// to local noon before diffing, so a 23- or 25-hour day still counts as 1.
export function dayDiff(a, b) {
  const noon = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
  };
  return Math.round((noon(b) - noon(a)) / 86400000);
}

// dates: array of local date-key strings (any order, duplicates ok)
// todayKey: local date-key for "now"
// tolerance: allowed skipped rest days between consecutive workout days
//   (0 = strict consecutive calendar days, 1 = one rest day allowed, …)
export function computeStreaks(dates, todayKey, tolerance = 1) {
  const unique = [...new Set(dates.filter(Boolean))].sort(); // ascending
  if (unique.length === 0) return { current: 0, longest: 0 };

  // Longest streak: scan ascending history
  let longest = 1;
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    const gap = dayDiff(unique[i - 1], unique[i]);
    run = gap >= 1 && gap <= tolerance + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // Current streak: walk backward from today (or yesterday, honoring the
  // same rest-day tolerance for "today not yet trained")
  let current = 0;
  const last = unique[unique.length - 1];
  const sinceLast = dayDiff(last, todayKey);
  if (sinceLast >= 0 && sinceLast <= tolerance + 1) {
    current = 1;
    for (let i = unique.length - 2; i >= 0; i--) {
      const gap = dayDiff(unique[i], unique[i + 1]);
      if (gap >= 1 && gap <= tolerance + 1) current++;
      else break;
    }
  }

  return { current, longest };
}
