// Data access for measurement_entries — the synced mirror of the client's
// local body_metrics table.
const { query } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Batch upsert keyed on (client_id, date, metric_type). client_id comes
// from the authenticated user, never the body.
async function upsertMeasurements(clientId, entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new HttpError(400, 'Body must be a non-empty array of measurement entries');
  }
  const rows = [];
  for (const e of entries) {
    if (!e || !e.date || !e.metric_type || e.value == null || isNaN(Number(e.value))) {
      throw new HttpError(400, 'Each entry requires date, metric_type and a numeric value');
    }
    const { rows: r } = await query(
      `INSERT INTO measurement_entries (client_id, date, metric_type, value, unit)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id, date, metric_type) DO UPDATE SET
         value = EXCLUDED.value, unit = EXCLUDED.unit, synced_at = now()
       RETURNING *`,
      [clientId, e.date, e.metric_type, Number(e.value), e.unit || '']
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listMeasurements(clientId, { metricType, from, to } = {}) {
  const { rows } = await query(
    `SELECT * FROM measurement_entries
     WHERE client_id = $1
       AND ($2::text IS NULL OR metric_type = $2)
       AND ($3::date IS NULL OR date >= $3)
       AND ($4::date IS NULL OR date <= $4)
     ORDER BY date ASC`,
    [clientId, metricType || null, from || null, to || null]
  );
  return rows;
}

// Distinct metric types this client actually tracks (drives the dropdown —
// never a hardcoded body-part list)
async function listMeasurementTypes(clientId) {
  const { rows } = await query(
    'SELECT DISTINCT metric_type FROM measurement_entries WHERE client_id = $1 ORDER BY metric_type',
    [clientId]
  );
  return rows.map((r) => r.metric_type);
}

module.exports = { upsertMeasurements, listMeasurements, listMeasurementTypes };
