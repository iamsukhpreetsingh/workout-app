// Data access for progression-formula config (System 2). Validates every
// write against the shared formulas.json metadata (unknown keys and
// out-of-range params are rejected at the API boundary), and resolves the
// trainer-override → own-setting → app-default precedence in ONE place.
const { query } = require('../db/pool');
const { assertActiveAssociation } = require('./assignedPlans');
const formulas = require('./progressionFormulas.json');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const APP_DEFAULT_KEY = 'linear_progression';

function listFormulas() {
  return formulas;
}

function findFormula(key) {
  return formulas.find((f) => f.key === key) || null;
}

function defaultParamsForKey(key) {
  const f = findFormula(key);
  const out = {};
  for (const p of (f && f.paramSchema) || []) out[p.key] = p.default;
  return out;
}

// Throws 400 on unknown formula key, unknown param name, non-numeric number,
// or values outside the schema's declared min/max. Missing params get their
// schema defaults — stored params are always complete.
function validateConfig(formulaKey, params) {
  const f = findFormula(formulaKey);
  if (!f) throw new HttpError(400, `Unknown formula_key: ${formulaKey}`);
  const schema = new Map((f.paramSchema || []).map((p) => [p.key, p]));
  const clean = {};
  for (const [k, v] of Object.entries(params || {})) {
    const p = schema.get(k);
    if (!p) throw new HttpError(400, `Unknown parameter '${k}' for formula '${formulaKey}'`);
    if (p.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) throw new HttpError(400, `Parameter '${k}' must be a number`);
      if (p.min != null && n < p.min) throw new HttpError(400, `Parameter '${k}' must be ≥ ${p.min}`);
      if (p.max != null && n > p.max) throw new HttpError(400, `Parameter '${k}' must be ≤ ${p.max}`);
      clean[k] = n;
    } else if (p.type === 'boolean') {
      clean[k] = !!v;
    } else {
      clean[k] = v;
    }
  }
  for (const p of f.paramSchema || []) {
    if (!(p.key in clean)) clean[p.key] = p.default;
  }
  return clean;
}

async function getUserSetting(userId) {
  const { rows } = await query(
    'SELECT formula_key, params FROM user_progression_settings WHERE user_id = $1', [userId]);
  if (rows.length) {
    return {
      formula_key: rows[0].formula_key,
      params: rows[0].params && Object.keys(rows[0].params).length
        ? rows[0].params
        : defaultParamsForKey(rows[0].formula_key),
    };
  }
  return { formula_key: APP_DEFAULT_KEY, params: defaultParamsForKey(APP_DEFAULT_KEY) };
}

async function upsertUserSetting(userId, formulaKey, params) {
  const clean = validateConfig(formulaKey, params);
  const { rows } = await query(
    `INSERT INTO user_progression_settings (user_id, formula_key, params)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       formula_key = EXCLUDED.formula_key, params = EXCLUDED.params, updated_at = now()
     RETURNING *`,
    [userId, formulaKey, JSON.stringify(clean)]
  );
  return rows[0];
}

// THE resolution endpoint's brain. Returns
// { formula_key, params, source, trainer_name } where source is
// 'trainer_override' | 'user_setting' | 'default' — the source flag is what
// the mobile app uses to lock the client's settings UI (System 4).
async function getResolved(userId) {
  // 1) most recent ACTIVE trainer override with a non-null formula_key.
  //    (Multiple trainers: latest updated_at wins; archived trainers'
  //    overrides stop applying with the association.)
  const { rows: ov } = await query(
    `SELECT o.formula_key, o.params, u.name AS trainer_name
     FROM trainer_client_progression_overrides o
     JOIN trainer_clients tc
       ON tc.trainer_id = o.trainer_id AND tc.client_id = o.client_id AND tc.status = 'active'
     JOIN users u ON u.id = o.trainer_id
     WHERE o.client_id = $1 AND o.formula_key IS NOT NULL
     ORDER BY o.updated_at DESC
     LIMIT 1`,
    [userId]
  );
  if (ov.length) {
    return {
      formula_key: ov[0].formula_key,
      params: ov[0].params && Object.keys(ov[0].params).length
        ? ov[0].params
        : defaultParamsForKey(ov[0].formula_key),
      source: 'trainer_override',
      trainer_name: ov[0].trainer_name,
    };
  }
  // 2) the user's own saved setting, else 3) the app default
  const { rows: own } = await query(
    'SELECT formula_key, params FROM user_progression_settings WHERE user_id = $1', [userId]);
  if (own.length) {
    return {
      formula_key: own[0].formula_key,
      params: own[0].params && Object.keys(own[0].params).length
        ? own[0].params
        : defaultParamsForKey(own[0].formula_key),
      source: 'user_setting',
      trainer_name: null,
    };
  }
  return {
    formula_key: APP_DEFAULT_KEY,
    params: defaultParamsForKey(APP_DEFAULT_KEY),
    source: 'default',
    trainer_name: null,
  };
}

async function getOverride(trainerId, clientId) {
  const { rows } = await query(
    `SELECT formula_key, params, updated_at FROM trainer_client_progression_overrides
     WHERE trainer_id = $1 AND client_id = $2`,
    [trainerId, clientId]
  );
  return rows[0] || null;
}

async function setOverride(trainerId, clientId, formulaKey, params) {
  if (!formulaKey) throw new HttpError(400, 'formula_key is required (use DELETE to clear an override)');
  await assertActiveAssociation(trainerId, clientId);
  const clean = validateConfig(formulaKey, params);
  const { rows } = await query(
    `INSERT INTO trainer_client_progression_overrides (trainer_id, client_id, formula_key, params)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (trainer_id, client_id) DO UPDATE SET
       formula_key = EXCLUDED.formula_key, params = EXCLUDED.params, updated_at = now()
     RETURNING *`,
    [trainerId, clientId, formulaKey, JSON.stringify(clean)]
  );
  return rows[0];
}

async function clearOverride(trainerId, clientId) {
  await assertActiveAssociation(trainerId, clientId);
  const { rows } = await query(
    `UPDATE trainer_client_progression_overrides
     SET formula_key = NULL, params = NULL, updated_at = now()
     WHERE trainer_id = $1 AND client_id = $2
     RETURNING *`,
    [trainerId, clientId]
  );
  return rows[0] || null;
}

module.exports = {
  listFormulas,
  validateConfig,
  getUserSetting,
  upsertUserSetting,
  getResolved,
  getOverride,
  setOverride,
  clearOverride,
};