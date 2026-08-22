// Allergen conflict matching — the ONLY auto-matched field in the app
// (explicit design decision: goals / injuries / medical conditions are
// NEVER auto-matched; see README). Matching operates purely on the
// explicit allergen tags both sides already carry — case-insensitive
// tag comparison, no synonyms, no ingredient inference.
export function getAllergenConflicts(clientAllergens = [], itemAllergens = []) {
  const client = new Set(
    (Array.isArray(clientAllergens) ? clientAllergens : [])
      .map((a) => String(a).trim().toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const conflicts = [];
  for (const a of Array.isArray(itemAllergens) ? itemAllergens : []) {
    const key = String(a).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (client.has(key)) conflicts.push(String(a).trim());
  }
  return conflicts; // keeps the recipe's own casing, e.g. ['Nuts']
}

// Splits a recipe's allergen tags into { conflicts, others } against the
// client's allergens — lets the picker row show the client-specific
// warning chip separately from the neutral "Contains:" info chip.
export function splitAllergens(clientAllergens = [], itemAllergens = []) {
  const conflicts = getAllergenConflicts(clientAllergens, itemAllergens);
  const conflictKeys = new Set(conflicts.map((a) => a.toLowerCase()));
  const others = [];
  const seen = new Set();
  for (const a of Array.isArray(itemAllergens) ? itemAllergens : []) {
    const tag = String(a).trim();
    const key = tag.toLowerCase();
    if (!key || seen.has(key) || conflictKeys.has(key)) continue;
    seen.add(key);
    others.push(tag);
  }
  return { conflicts, others };
}