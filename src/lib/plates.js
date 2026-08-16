// Pure plate math — unit-agnostic. All weights must be in the same unit
// (the app's current display unit); no silent conversion happens here.
export function plateBreakdown(weight, barWeight, plates) {
  if (weight == null || isNaN(weight)) return { error: 'invalid' };
  if (weight < barWeight) return { belowBar: true, perSide: [], leftover: 0 };
  const perSide = (weight - barWeight) / 2;
  const sorted = [...plates].sort((a, b) => b - a);
  let remaining = perSide;
  const breakdown = [];
  for (const size of sorted) {
    const count = Math.floor((remaining + 1e-9) / size);
    if (count > 0) {
      breakdown.push({ size, count });
      remaining -= count * size;
    }
  }
  remaining = Math.round(remaining * 100) / 100;
  return {
    belowBar: false,
    perSide: breakdown,
    leftover: remaining, // weight per side that could not be matched
    exact: remaining < 0.005,
  };
}
