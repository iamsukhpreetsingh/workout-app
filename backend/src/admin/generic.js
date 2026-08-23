// Generic entity browser — the FIRST auto-discovery mechanism. Introspects
// the live Postgres schema (information_schema) so every table, including
// ones added by future migrations, is browsable/editable with zero code.
const express = require('express');
const { query } = require('../db/pool');
const { requireAdmin, requireAdminRole } = require('./auth');
const tableConfig = require('./tableConfig');
const { registerRoute } = require('./registry');
const { writeAudit } = require('./audit');

const router = express.Router();
router.use(requireAdmin());

const SENSITIVE = new Set(tableConfig.sensitiveColumns);

async function getSchema() {
  const cols = await query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );
  const pk = await query(
    `SELECT kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`
  );
  const fk = await query(
    `SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
  );
  const tables = {};
  for (const c of cols.rows) {
    if (tableConfig.excluded.includes(c.table_name)) continue;
    if (!tables[c.table_name]) tables[c.table_name] = { name: c.table_name, columns: [], primaryKey: [], foreignKeys: [], customModule: tableConfig.customModules[c.table_name] || null, roles: tableRoles(c.table_name) };
    const sensitive = SENSITIVE.has(c.column_name);
    tables[c.table_name].columns.push({
      name: c.column_name,
      data_type: c.data_type,
      nullable: c.is_nullable === 'YES',
      default: c.column_default,
      sensitive, // masked in every response — never leaves the server
    });
  }
  for (const p of pk.rows) {
    if (tables[p.table_name]) tables[p.table_name].primaryKey.push(p.column_name);
  }
  for (const f of fk.rows) {
    if (tables[f.table_name]) {
      tables[f.table_name].foreignKeys.push({ column: f.column_name, ref_table: f.ref_table, ref_column: f.ref_column });
    }
  }
  return Object.values(tables).sort((a, b) => a.name.localeCompare(b.name));
}

function tableRoles(table) {
  const o = tableConfig.tables[table] || {};
  return {
    read: o.readRole || 'support',
    write: o.writeRole === null ? null : o.writeRole || 'super_admin',
  };
}

async function assertTableKnown(table) {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  if (!rows.length || tableConfig.excluded.includes(table)) {
    const e = new Error('Unknown table');
    e.status = 404;
    throw e;
  }
}

async function columnsOf(table) {
  const { rows } = await query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows;
}

// strip sensitive columns from every outgoing row
function maskRows(rows) {
  return rows.map((r) => {
    const c = { ...r };
    for (const k of Object.keys(c)) if (SENSITIVE.has(k)) c[k] = '***';
    return c;
  });
}

const canRead = (admin, table) => {
  const roles = tableRoles(table);
  if (admin.role === 'super_admin') return true;
  if (admin.role === 'read_only') return true; // read everywhere
  if (admin.role === 'analyst') return true; // generic browser read-only access
  if (admin.role === 'content_moderator' && ['content_moderator', 'support'].includes(roles.read)) return true;
  return roles.read === 'support' || admin.role === roles.read;
};

const canWrite = (admin, table) => {
  const roles = tableRoles(table);
  if (roles.write === null) return false;
  return admin.role === roles.write || (admin.role === 'super_admin' && roles.write !== null);
};

// ── schema endpoint ──────────────────────────────────────────────────
registerRoute(router, {
  method: 'GET', path: '/schema', category: 'System',
  description: 'Live database introspection: every public table with columns, PK, FKs, role rules. Reflects new migrations instantly.',
  allowedRoles: ['any authenticated admin'],
}, async (req, res) => {
  try {
    // hide tables the caller can't read at all is overkill — the schema is
    // structural metadata; row data is what's gated per table.
    res.json(await getSchema());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── generic list ─────────────────────────────────────────────────────
registerRoute(router, {
  method: 'GET', path: '/data/:table', category: 'System',
  description: 'Paginated, sortable, filterable read of ANY table. Table name validated against the live schema; sensitive columns masked.',
  allowedRoles: ['read: per-table config, default support+'],
}, async (req, res) => {
  try {
    const table = req.params.table;
    await assertTableKnown(table);
    if (!canRead(req.admin, table)) return res.status(403).json({ error: 'Insufficient role for this table' });

    const cols = (await columnsOf(table)).map((c) => c.column_name);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

    // sort: ?sort=col or ?sort=-col (desc) — validated against real columns
    let orderBy = '';
    if (req.query.sort) {
      const desc = req.query.sort.startsWith('-');
      const col = desc ? req.query.sort.slice(1) : req.query.sort;
      if (!cols.includes(col)) return res.status(400).json({ error: `Unknown sort column ${col}` });
      orderBy = `ORDER BY "${col}" ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
    }

    // filter: any ?col=value whose col exists on the table (exact or ILIKE)
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(req.query)) {
      if (['page', 'pageSize', 'sort'].includes(k) || v === '') continue;
      if (!cols.includes(k)) continue;
      params.push(v);
      const i = params.length;
      if (/^-?\d+(\.\d+)?$/.test(v) && !v.includes('.')) {
        where.push(`"${k}"::text = $${i}`);
      } else {
        where.push(`"${k}"::text ILIKE $${i}`);
        params[i - 1] = `%${v}%`;
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const count = await query(`SELECT count(*)::int AS c FROM "${table}" ${whereSql}`, params);
    const { rows } = await query(
      `SELECT * FROM "${table}" ${whereSql} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ total: count.rows[0].c, page, pageSize, rows: maskRows(rows) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── single row ───────────────────────────────────────────────────────
registerRoute(router, {
  method: 'GET', path: '/data/:table/:id', category: 'System',
  description: 'Single-row fetch by primary key (UUID or integer).',
  allowedRoles: ['read: per-table config'],
}, async (req, res) => {
  try {
    const table = req.params.table;
    await assertTableKnown(table);
    if (!canRead(req.admin, table)) return res.status(403).json({ error: 'Insufficient role for this table' });
    const schema = (await getSchema()).find((t) => t.name === table);
    const pk = schema.primaryKey[0] || 'id';
    const { rows } = await query(`SELECT * FROM "${table}" WHERE "${pk}"::text = $1 LIMIT 1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Row not found' });
    res.json(maskRows(rows)[0]);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── generic update (super_admin by default; per-table override) ──────
registerRoute(router, {
  method: 'PATCH', path: '/data/:table/:id', category: 'System',
  description: 'Generic row update. Fields validated against the live column list; sensitive columns rejected; audited.',
  allowedRoles: ['write: per-table config, default super_admin'],
}, async (req, res) => {
  try {
    const table = req.params.table;
    await assertTableKnown(table);
    if (!canWrite(req.admin, table)) return res.status(403).json({ error: 'Insufficient role to edit this table' });
    const schema = (await getSchema()).find((t) => t.name === table);
    const pk = schema.primaryKey[0] || 'id';
    const colTypes = Object.fromEntries(schema.columns.map((c) => [c.name, c.data_type]));

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      if (SENSITIVE.has(k)) return res.status(400).json({ error: `Column ${k} is not editable through the generic browser` });
      if (schema.primaryKey.includes(k)) continue;
      if (!(k in colTypes)) return res.status(400).json({ error: `Unknown column ${k}` });
      params.push(v === '' ? null : v);
      sets.push(`"${k}" = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(req.params.id);

    const before = await query(`SELECT * FROM "${table}" WHERE "${pk}"::text = $1 LIMIT 1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Row not found' });
    const { rows } = await query(
      `UPDATE "${table}" SET ${sets.join(', ')} WHERE "${pk}"::text = $${params.length} RETURNING *`,
      params
    );
    await writeAudit(req.admin, 'generic_update', table, req.params.id, maskRows(before.rows)[0], maskRows(rows)[0]);
    res.json(maskRows(rows)[0]);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── generic delete ───────────────────────────────────────────────────
registerRoute(router, {
  method: 'DELETE', path: '/data/:table/:id', category: 'System',
  description: 'Generic row delete (super_admin by default). Audited.',
  allowedRoles: ['write: per-table config, default super_admin'],
}, async (req, res) => {
  try {
    const table = req.params.table;
    await assertTableKnown(table);
    if (!canWrite(req.admin, table)) return res.status(403).json({ error: 'Insufficient role to delete in this table' });
    const schema = (await getSchema()).find((t) => t.name === table);
    const pk = schema.primaryKey[0] || 'id';
    const before = await query(`SELECT * FROM "${table}" WHERE "${pk}"::text = $1 LIMIT 1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Row not found' });
    await query(`DELETE FROM "${table}" WHERE "${pk}"::text = $1`, [req.params.id]);
    await writeAudit(req.admin, 'generic_delete', table, req.params.id, maskRows(before.rows)[0], null);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = { router, getSchema, assertTableKnown, maskRows };
