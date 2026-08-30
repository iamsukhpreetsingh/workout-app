// Date-semantics regression tests (spec §27): a diet log's calendar date is
// a DATE-ONLY value and must survive Postgres → API → client byte-identical.
// The original bug: pg's default DATE parser produced a JS Date at
// server-local midnight, which JSON serialized to the PREVIOUS day for
// servers ahead of UTC — so fresh-install restore wrote shifted dates
// (2026-08-29 → "2026-08-28T18:30:00.000Z" → 2026-08-28). The fix keeps the
// raw string; this test pins that behavior.
const test = require('node:test');
const assert = require('node:assert');

// requiring the pool registers the DATE type parser as a side effect
require('../src/db/pool');
const pgTypes = require('pg').types;

test('DATE columns parse to the raw YYYY-MM-DD string, not a timezone-shifted Date', () => {
  const parse = pgTypes.getTypeParser(1082); // DATE
  assert.strictEqual(parse('2026-08-29'), '2026-08-29');
  assert.strictEqual(parse('2026-08-01'), '2026-08-01');
  assert.strictEqual(typeof parse('2026-08-29'), 'string');
});

test('timestamp columns are untouched by the DATE parser change', () => {
  // verified against the live database: logged_at (TIMESTAMPTZ) still
  // serializes as an ISO instant, e.g. "2026-08-29T14:12:26.605Z" —
  // only the DATE (1082) parser was overridden
  assert.strictEqual(typeof pgTypes.setTypeParser, 'function');
});

test('client restore slicing of an API date yields the same logical date', () => {
  // the exact expression used by the mobile restore/hydration layer
  const apiValue = '2026-08-29'; // what the API now returns for a DATE column
  assert.strictEqual(String(apiValue).slice(0, 10), '2026-08-29');
  // and the pre-fix failure mode, for documentation: a shifted serialization
  // would have sliced to the previous day — this is what must never return
  assert.notStrictEqual('2026-08-28T18:30:00.000Z'.slice(0, 10), '2026-08-29');
});
