// Audit logging — every admin write/delete lands in admin_audit_log.
// Non-blocking: an audit failure must never break the audited action.
const { query } = require('../db/pool');

async function writeAudit(admin, action, targetTable = null, targetId = null, before = null, after = null) {
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_table, target_id, before_values, after_values)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        admin ? admin.id : null,
        action,
        targetTable,
        targetId != null ? String(targetId) : null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ]
    );
  } catch (e) {
    console.error('[AUDIT] write failed:', e.message);
  }
}

// Read-audit — for extra-sensitive data (e.g. client intake profiles),
// VIEWING is itself logged. Same non-blocking guarantees as writeAudit.
async function readAudit(admin, action, targetTable = null, targetId = null) {
  return writeAudit(admin, action, targetTable, targetId, null, null);
}

module.exports = { writeAudit, readAudit };
