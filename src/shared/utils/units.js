// Unit conversion + display helpers. All weights are stored in kg in the
// database; conversion happens only at the display/input boundary.
const KG_TO_LB = 2.20462;

/**
 * Convert kilograms to pounds.
 * @param {number} kg
 * @returns {number}
 */
export function kgToLb(kg) {
  return kg * KG_TO_LB;
}

/**
 * Convert pounds to kilograms.
 * @param {number} lb
 * @returns {number}
 */
export function lbToKg(lb) {
  return lb / KG_TO_LB;
}

/**
 * Format a kg value as a string in the given display unit.
 * @param {number|null} kgValue
 * @param {'kg'|'lb'} displayUnit
 * @param {{decimals?: number}} [options]
 * @returns {string} formatted weight, or '' for null/undefined input
 */
export function formatWeight(kgValue, displayUnit, options = {}) {
  if (!kgValue && kgValue !== 0) return '';
  const { decimals = 1 } = options;
  if (displayUnit === 'lb') {
    const lb = kgToLb(kgValue);
    return lb.toFixed(decimals > 0 ? decimals : 0);
  }
  return kgValue.toFixed(decimals);
}

/**
 * Parse user-entered weight text in the current display unit into kg.
 * @param {string} inputValue
 * @param {'kg'|'lb'} currentUnit
 * @returns {number} weight in kg (0 if unparseable)
 */
export function parseWeight(inputValue, currentUnit) {
  const num = parseFloat(inputValue);
  if (isNaN(num)) return 0;
  if (currentUnit === 'lb') {
    return lbToKg(num);
  }
  return num;
}

/**
 * Get the numeric weight to display in the current unit (no string padding).
 * @param {number|null} kgValue
 * @param {'kg'|'lb'} displayUnit
 * @returns {number|''} rounded number in display unit, or '' for null/undefined
 */
export function getDisplayWeight(kgValue, displayUnit) {
  if (!kgValue && kgValue !== 0) return '';
  if (displayUnit === 'lb') {
    return Math.round(kgToLb(kgValue) * 10) / 10;
  }
  return kgValue;
}

export const PLATES = {
  kg: [20, 15, 10, 5, 2.5, 1.25],
  lb: [45, 35, 25, 10, 5, 2.5],
};

export const BAR_WEIGHT = {
  kg: 20,
  lb: 45,
};
