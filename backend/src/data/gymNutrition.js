// gymNutrition.js — gym-owned nutrition content (Phase 12).
//
// Mirrors the Phase 11 workout architecture exactly:
//  - gym-owned items (RECIPE / MEAL_PLAN / DIET_RECOMMENDATION) with a
//    version counter bumped on content edits
//  - direct assignments referencing gym_members (app_user_id NULL fully
//    valid, stored until the member connects; member leave/reconnect safe)
//  - snapshot saves: a member's personal copy is a full JSONB copy at their
//    saved version; gym edits never move it — only an explicit update does
//  - recommended distribution to all eligible app-connected members
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KINDS = ['RECIPE', 'MEAL_PLAN', 'DIET_RECOMMENDATION'];
const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const TARGET_KEYS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];

function validateItem(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.kind !== undefined) {
    if (!KINDS.includes(data.kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
    out.kind = data.kind;
  }
  if (!partial || data.title !== undefined) {
    const title = String(data.title || '').trim();
    if (!title || title.length > 140) throw new HttpError(400, 'title is required (max 140 characters)');
    out.title = title;
  }
  if (data.description !== undefined) out.description = data.description || null;
  if (!partial || data.content !== undefined) {
    const content = data.content ?? { entries: [] };
    if (typeof content !== 'object' || Array.isArray(content) || content === null) {
      throw new HttpError(400, 'content must be an object');
    }
    if (content.entries !== undefined && !Array.isArray(content.entries)) {
      throw new HttpError(400, 'content.entries must be an array of strings');
    }
    out.content = {
      entries: (content.entries || []).map((e) => String(e).trim()).filter(Boolean).slice(0, 100),
    };
  }
  if (data.targets !== undefined) {
    if (data.targets == null) { out.targets = null; }
    else {
      if (typeof data.targets !== 'object' || Array.isArray(data.targets)) {
        throw new HttpError(400, 'targets must be an object');
      }
      const t = {};
      for (const key of TARGET_KEYS) {
        if (data.targets[key] != null) {
          const n = Number(data.targets[key]);
          if (!Number.isFinite(n) || n < 0 || n > 100000) {
            throw new HttpError(400, `targets.${key} must be a number between 0 and 100000`);
          }
          t[key] = n;
        }
      }
      out.targets = t;
    }
  }
  if (data.tags !== undefined) {
    if (data.tags != null && !Array.isArray(data.tags)) throw new HttpError(400, 'tags must be an array of strings');
    out.tags = (data.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  }
  if (data.recommended !== undefined) out.recommended = !!data.recommended;
  if (data.status !== undefined) {
    if (!STATUSES.includes(data.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    out.status = data.status;
  }
  return out;
}

const CONTENT_FIELDS = ['title', 'description', 'content', 'targets', 'tags'];

async function createItem(gymId, actor, ip, data, gymAudit) {
  const fields = validateItem(data, { partial: false });
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO gym_nutrition_items
         (gym_id, kind, title, description, content, targets, tags, status, recommended, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [gymId, fields.kind, fields.title, fields.description ?? null,
       JSON.stringify(fields.content), fields.targets ? JSON.stringify(fields.targets) : null,
       fields.tags || [], fields.status ?? 'DRAFT', fields.recommended ?? false,
       actor?.userId ?? actor ?? null]
    );
    const item = rows[0];
    item.content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.created', entity: 'gym_nutrition_item', entityId: item.id,
      after: { kind: item.kind, title: item.title, status: item.status },
    });
    return item;
  });
}

async function updateItem(gymId, itemId, actor, ip, patch, gymAudit) {
  const fields = validateItem(patch, { partial: true });
  const contentChanged = CONTENT_FIELDS.some((k) => fields[k] !== undefined);
  return transaction(async (client) => {
    const { rows: beforeRows } = await client.query(
      'SELECT * FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [itemId, gymId]
    );
    if (!beforeRows.length) throw new HttpError(404, 'Nutrition item not found');
    const before = beforeRows[0];
    const sets = [];
    const vals = [itemId, gymId];
    for (const [k, v] of Object.entries(fields)) {
      vals.push(k === 'content' || k === 'targets'
        ? (v === null ? null : JSON.stringify(v))
        : (v === undefined ? null : v));
      sets.push(`${k} = $${vals.length}`);
    }
    if (contentChanged) {
      vals.push(before.version + 1);
      sets.push(`version = $${vals.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'No valid fields to update');
    const { rows } = await client.query(
      `UPDATE gym_nutrition_items SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      vals
    );
    const item = rows[0];
    item.content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.updated', entity: 'gym_nutrition_item', entityId: itemId,
      before: { status: before.status, version: before.version },
      after: { status: item.status, version: item.version },
    });
    return item;
  });
}

async function listItems(gymId, { status, q, kind, recommended } = {}) {
  const vals = [gymId];
  const where = ['n.gym_id = $1'];
  if (status) { vals.push(status); where.push(`n.status = $${vals.length}`); }
  if (kind) { vals.push(kind); where.push(`n.kind = $${vals.length}`); }
  if (recommended != null && recommended !== '') { vals.push(recommended === 'true'); where.push(`n.recommended = $${vals.length}`); }
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(n.title ILIKE $${vals.length} OR n.description ILIKE $${vals.length})`);
  }
  const { rows } = await query(
    `SELECT n.*,
            (SELECT COUNT(*)::int FROM gym_nutrition_assignments a WHERE a.item_id = n.id AND a.status = 'ACTIVE') AS assigned_count,
            (SELECT COUNT(*)::int FROM gym_nutrition_saves s WHERE s.item_id = n.id) AS saves_count
     FROM gym_nutrition_items n WHERE ${where.join(' AND ')}
     ORDER BY (n.status = 'PUBLISHED') DESC, n.updated_at DESC`,
    vals
  );
  return rows.map(parseItem);
}

function parseItem(row) {
  return {
    ...row,
    content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
    targets: typeof row.targets === 'string' ? JSON.parse(row.targets) : row.targets,
  };
}

async function getItem(gymId, itemId) {
  const { rows } = await query(
    'SELECT * FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2', [itemId, gymId]
  );
  return rows[0] ? parseItem(rows[0]) : null;
}

// ── direct assignment ────────────────────────────────────────────────────

async function assignItem(gymId, memberId, actor, ip, { item_id } = {}, gymAudit) {
  if (!item_id) throw new HttpError(400, 'item_id is required');
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT id, status FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE',
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].status === 'CANCELLED') {
      throw new HttpError(400, 'This member has left the gym — reactivate them first');
    }
    const { rows: itemRows } = await client.query(
      'SELECT * FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2',
      [item_id, gymId]
    );
    if (!itemRows.length) throw new HttpError(404, 'Nutrition item not found');
    const item = itemRows[0];
    if (item.status === 'DRAFT') throw new HttpError(400, 'Publish the item before assigning it');
    if (item.status === 'ARCHIVED') {
      throw new HttpError(409, 'Archived content cannot be assigned to members');
    }
    const { rows: dupes } = await client.query(
      `SELECT id FROM gym_nutrition_assignments
       WHERE member_id = $1 AND item_id = $2 AND status = 'ACTIVE'`,
      [memberId, item_id]
    );
    if (dupes.length) throw new HttpError(409, 'This item is already assigned to this member');
    const { rows } = await client.query(
      `INSERT INTO gym_nutrition_assignments (gym_id, item_id, member_id, assigned_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [gymId, item_id, memberId, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.assigned', entity: 'gym_nutrition_assignment', entityId: rows[0].id,
      after: { item: item.title, member: memberId },
    });
    return { ...rows[0], item_title: item.title, item_kind: item.kind, item_version: item.version };
  });
}

async function endAssignment(gymId, assignmentId, actor, ip, { reason } = {}, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_nutrition_assignments WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
      [assignmentId, gymId]
    );
    if (!rows.length) throw new HttpError(404, 'Assignment not found');
    if (rows[0].status !== 'ACTIVE') throw new HttpError(400, 'This assignment has already ended');
    await client.query(
      `UPDATE gym_nutrition_assignments SET status = 'ENDED', end_reason = $2, updated_at = now() WHERE id = $1`,
      [assignmentId, reason || 'unassigned']
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.unassigned', entity: 'gym_nutrition_assignment', entityId: assignmentId,
      after: { reason: reason || 'unassigned' },
    });
    return { ok: true };
  });
}

async function listMemberAssignments(gymId, memberId) {
  const { rows } = await query(
    `SELECT a.*, n.title AS item_title, n.kind AS item_kind, n.version AS item_version,
            n.status AS item_status, u.name AS assigned_by_name
     FROM gym_nutrition_assignments a
     JOIN gym_nutrition_items n ON n.id = a.item_id
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.gym_id = $1 AND a.member_id = $2
     ORDER BY a.created_at DESC`,
    [gymId, memberId]
  );
  return rows;
}

// ── snapshot saves ───────────────────────────────────────────────────────

async function saveItemForMember(gymId, memberId, itemId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      'SELECT id FROM gym_members WHERE id = $1 AND gym_id = $2', [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    const { rows: itemRows } = await client.query(
      'SELECT * FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2', [itemId, gymId]
    );
    if (!itemRows.length) throw new HttpError(404, 'Nutrition item not found');
    const item = parseItem(itemRows[0]);
    if (item.status === 'DRAFT') throw new HttpError(400, 'This item is not published');
    const { rows: dupes } = await client.query(
      'SELECT id FROM gym_nutrition_saves WHERE item_id = $1 AND member_id = $2',
      [itemId, memberId]
    );
    if (dupes.length) {
      throw new HttpError(409, 'Already in your library — use "update" to pull the latest version');
    }
    const snapshot = {
      kind: item.kind, title: item.title, description: item.description,
      content: item.content, targets: item.targets, tags: item.tags,
    };
    const { rows } = await client.query(
      `INSERT INTO gym_nutrition_saves (gym_id, item_id, member_id, saved_version, snapshot)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [gymId, itemId, memberId, item.version, JSON.stringify(snapshot)]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.saved', entity: 'gym_nutrition_save', entityId: rows[0].id,
      after: { item: item.title, saved_version: item.version },
    });
    return rows[0];
  });
}

async function updateSavedItem(gymId, memberId, saveId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows: saveRows } = await client.query(
      `SELECT * FROM gym_nutrition_saves WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [saveId, gymId, memberId]
    );
    if (!saveRows.length) throw new HttpError(404, 'Saved item not found');
    const save = saveRows[0];
    const { rows: itemRows } = await client.query(
      'SELECT * FROM gym_nutrition_items WHERE id = $1 AND gym_id = $2', [save.item_id, gymId]
    );
    if (!itemRows.length || itemRows[0].status === 'ARCHIVED') {
      throw new HttpError(409, 'The gym original is no longer available — your saved copy is untouched');
    }
    const item = parseItem(itemRows[0]);
    const snapshot = {
      kind: item.kind, title: item.title, description: item.description,
      content: item.content, targets: item.targets, tags: item.tags,
    };
    const { rows } = await client.query(
      `UPDATE gym_nutrition_saves SET saved_version = $3, snapshot = $4, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [save.id, gymId, item.version, JSON.stringify(snapshot)]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.save_updated', entity: 'gym_nutrition_save', entityId: save.id,
      before: { saved_version: save.saved_version }, after: { saved_version: item.version },
    });
    return rows[0];
  });
}

async function deleteSavedItem(gymId, memberId, saveId, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `DELETE FROM gym_nutrition_saves WHERE id = $1 AND gym_id = $2 AND member_id = $3 RETURNING id`,
      [saveId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Saved item not found');
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'nutrition.save_removed', entity: 'gym_nutrition_save', entityId: saveId,
    });
    return { ok: true };
  });
}

// ── member-facing aggregation (mobile) ───────────────────────────────────

async function listForMember(userId) {
  const memberships = await query(
    `SELECT m.id AS member_id, m.gym_id, g.name AS gym_name,
            EXISTS (SELECT 1 FROM member_memberships t
                    WHERE t.member_id = m.id AND t.status = 'ACTIVE') AS has_active_term
     FROM gym_members m JOIN gyms g ON g.id = m.gym_id
     WHERE m.app_user_id = $1 AND m.status = 'ACTIVE' AND g.status = 'ACTIVE'`,
    [userId]
  );
  const out = [];
  for (const mem of memberships.rows) {
    const recommended = mem.has_active_term ? await query(
      `SELECT n.id, n.gym_id, n.kind, n.title, n.description, n.content, n.targets, n.tags, n.version
       FROM gym_nutrition_items n
       WHERE n.gym_id = $1 AND n.status = 'PUBLISHED' AND n.recommended = true
       ORDER BY n.updated_at DESC`,
      [mem.gym_id]
    ) : { rows: [] };
    const assigned = await query(
      `SELECT a.id AS assignment_id, a.created_at AS assigned_at,
              n.id, n.gym_id, n.kind, n.title, n.description, n.content, n.targets, n.tags,
              n.version, n.status AS item_status
       FROM gym_nutrition_assignments a
       JOIN gym_nutrition_items n ON n.id = a.item_id
       WHERE a.member_id = $1 AND a.status = 'ACTIVE' AND n.status = 'PUBLISHED'
       ORDER BY a.created_at DESC`,
      [mem.member_id]
    );
    const saves = await query(
      `SELECT s.id AS save_id, s.saved_version, s.snapshot, s.saved_at,
              n.id AS item_id, n.version AS current_version, n.status AS item_status
       FROM gym_nutrition_saves s JOIN gym_nutrition_items n ON n.id = s.item_id
       WHERE s.member_id = $1
       ORDER BY s.saved_at DESC`,
      [mem.member_id]
    );
    out.push({
      gym_id: mem.gym_id, gym_name: mem.gym_name,
      recommended: recommended.rows.map(parseItem),
      assigned: assigned.rows.map(parseItem),
      saved: saves.rows.map((r) => ({
        ...r,
        snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot,
        update_available: r.item_status === 'PUBLISHED' && r.current_version > r.saved_version,
      })),
    });
  }
  return out;
}

module.exports = {
  KINDS, STATUSES,
  createItem, updateItem, listItems, getItem,
  assignItem, endAssignment, listMemberAssignments,
  saveItemForMember, updateSavedItem, deleteSavedItem, listForMember,
};
