const KG_TO_LB = 2.20462;

export function kgToLb(kg) {
  return kg * KG_TO_LB;
}

export function lbToKg(lb) {
  return lb / KG_TO_LB;
}

export function formatWeight(kgValue, displayUnit, options = {}) {
  if (!kgValue && kgValue !== 0) return '';
  const { decimals = 1 } = options;
  if (displayUnit === 'lb') {
    const lb = kgToLb(kgValue);
    return lb.toFixed(decimals > 0 ? decimals : 0);
  }
  return kgValue.toFixed(decimals);
}

export function parseWeight(inputValue, currentUnit) {
  const num = parseFloat(inputValue);
  if (isNaN(num)) return 0;
  if (currentUnit === 'lb') {
    return lbToKg(num);
  }
  return num;
}

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