// gymTrainers.js — gym trainer ↔ member assignments (Phase 8).
//
// RULES:
//  - Assignments reference gym_members (NOT users), so a member with
//    app_user_id = NULL has an assigned trainer exactly like anyone else.
//  - Only gym_staff rows with gym_role 'TRAINER' and status 'ACTIVE' can
//    take assignments; a platform trainer (users.role 'trainer') who is not
//    gym staff cannot be assigned here.
//  - One ACTIVE assignment per member per gym; assigning again ENDS the
//    previous one with reason 'reassigned' (history kept).
//  - A trainer with ACTIVE assignments cannot be deactivated, removed, or
//    have their role changed — members must be reassigned first
//    (enforced here via countActiveAssignments and in gyms.updateGymStaff).
const { query, transaction } = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Number of ACTIVE assignments held by a staff row (used by the removal
// guard and by the Trainers page).
async function countActiveAssignments(gymId, trainerStaffId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM gym_trainer_assignments
     WHERE gym_id = $1 AND trainer_staff_id = $2 AND status = 'ACTIVE'`,
    [gymId, trainerStaffId]
  );
  return rows[0].c;
}

// The gym's assignable trainers: ACTIVE staff with the TRAINER role.
async function listAssignableTrainers(gymId) {
  const { rows } = await query(
    `SELECT s.id AS trainer_staff_id, s.gym_role, s.status, u.name, u.email
     FROM gym_staff s JOIN users u ON u.id = s.user_id
     WHERE s.gym_id = $1 AND s.gym_role = 'TRAINER' AND s.status = 'ACTIVE'
     ORDER BY u.name`,
    [gymId]
  );
  return rows;
}

// Assign (or reassign) a gym trainer to a member. Works with app_user_id
// NULL or set — nothing here touches app accounts.
async function assignTrainer(gymId, memberId, actor, ip, { trainer_staff_id } = {}, gymAudit) {
  if (!trainer_staff_id) throw new HttpError(400, 'trainer_staff_id is required');
  return transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      `SELECT * FROM gym_members WHERE id = $1 AND gym_id = $2 FOR UPDATE`,
      [memberId, gymId]
    );
    if (!memberRows.length) throw new HttpError(404, 'Member not found');
    if (memberRows[0].status === 'CANCELLED') {
      throw new HttpError(400, 'This member has left the gym — reactivate them before assigning a trainer');
    }
    const { rows: staffRows } = await client.query(
      `SELECT s.*, u.name AS trainer_name FROM gym_staff s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.gym_id = $2 FOR UPDATE`,
      [trainer_staff_id, gymId]
    );
    if (!staffRows.length) throw new HttpError(404, 'Trainer not found at this gym');
    const trainer = staffRows[0];
    if (trainer.gym_role !== 'TRAINER') {
      throw new HttpError(400, 'Only staff with the TRAINER role can be assigned to members');
    }
    if (trainer.status !== 'ACTIVE') {
      throw new HttpError(400, 'This trainer is not active at this gym');
    }

    // end any current assignment (history kept, reason 'reassigned')
    const { rows: current } = await client.query(
      `SELECT * FROM gym_trainer_assignments WHERE member_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [memberId]
    );
    if (current.length && current[0].trainer_staff_id === trainer_staff_id) {
      throw new HttpError(409, 'This trainer is already assigned to this member');
    }
    for (const prev of current) {
      await client.query(
        `UPDATE gym_trainer_assignments SET status = 'ENDED', ended_on = (now() AT TIME ZONE
           (SELECT timezone FROM gyms WHERE id = $3))::date, end_reason = 'reassigned', updated_at = now()
         WHERE id = $1 AND gym_id = $2`,
        [prev.id, gymId, gymId]
      );
    }
    const { rows } = await client.query(
      `INSERT INTO gym_trainer_assignments (gym_id, member_id, trainer_staff_id, assigned_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [gymId, memberId, trainer_staff_id, actor?.userId ?? actor ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'trainer.assigned', entity: 'gym_trainer_assignment', entityId: rows[0].id,
      after: { member: memberId, trainer: trainer.trainer_name, replaced: current[0]?.id ?? null },
    });
    return { ...rows[0], trainer_name: trainer.trainer_name };
  });
}

async function endTrainerAssignment(gymId, memberId, assignmentId, actor, ip, { reason } = {}, gymAudit) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM gym_trainer_assignments WHERE id = $1 AND gym_id = $2 AND member_id = $3 FOR UPDATE`,
      [assignmentId, gymId, memberId]
    );
    if (!rows.length) throw new HttpError(404, 'Assignment not found');
    if (rows[0].status !== 'ACTIVE') throw new HttpError(400, 'This assignment has already ended');
    const updated = await client.query(
      `UPDATE gym_trainer_assignments SET status = 'ENDED',
         ended_on = (now() AT TIME ZONE (SELECT timezone FROM gyms WHERE id = $3))::date,
         end_reason = $4, updated_at = now()
       WHERE id = $1 AND gym_id = $2 RETURNING *`,
      [assignmentId, gymId, gymId, reason || 'unassigned']
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? actor ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'trainer.unassigned', entity: 'gym_trainer_assignment', entityId: assignmentId,
      before: { status: 'ACTIVE' }, after: { status: 'ENDED', reason: reason || 'unassigned' },
    });
    if (!updated || !updated.rows) console.error('[DBG end] updated:', updated);
    return updated.rows[0];
  });
}

// A member's assignment history (with trainer names).
async function listMemberTrainerAssignments(gymId, memberId) {
  const { rows } = await query(
    `SELECT a.*, u.name AS trainer_name, u.email AS trainer_email,
            gm.first_name, gm.last_name, gm.member_code
     FROM gym_trainer_assignments a
     JOIN gym_staff s ON s.id = a.trainer_staff_id
     JOIN users u ON u.id = s.user_id
     JOIN gym_members gm ON gm.id = a.member_id
     WHERE a.gym_id = $1 AND a.member_id = $2
     ORDER BY a.starts_on DESC, a.created_at DESC`,
    [gymId, memberId]
  );
  return rows;
}

// Gym-wide assignments (Trainers page), optionally scoped to one trainer.
async function listGymTrainerAssignments(gymId, { trainer_staff_id } = {}) {
  const vals = [gymId];
  const where = ['a.gym_id = $1'];
  if (trainer_staff_id) { vals.push(trainer_staff_id); where.push(`a.trainer_staff_id = $${vals.length}`); }
  const { rows } = await query(
    `SELECT a.*, u.name AS trainer_name, u.email AS trainer_email,
            gm.first_name, gm.last_name, gm.member_code, gm.app_user_id
     FROM gym_trainer_assignments a
     JOIN gym_staff s ON s.id = a.trainer_staff_id
     JOIN users u ON u.id = s.user_id
     JOIN gym_members gm ON gm.id = a.member_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.starts_on DESC, a.created_at DESC`,
    vals
  );
  return rows;
}

// The trainer's own roster: ACTIVE assignments for THIS staff row, with
// each member's current membership status.
async function listAssignedMembersForTrainer(gymId, trainerStaffId) {
  const { rows } = await query(
    `SELECT a.id AS assignment_id, a.starts_on,
            gm.id AS member_id, gm.member_code, gm.first_name, gm.last_name,
            gm.phone, gm.email, gm.app_user_id, gm.status AS member_status,
            t.plan_name, t.membership_status, t.ends_on
     FROM gym_trainer_assignments a
     JOIN gym_members gm ON gm.id = a.member_id
     LEFT JOIN LATERAL (
       SELECT plan_name, status AS membership_status, ends_on
       FROM member_memberships mm
       WHERE mm.member_id = gm.id AND mm.status IN ('ACTIVE','FROZEN','UPCOMING')
       ORDER BY (mm.status = 'ACTIVE') DESC, mm.starts_on DESC LIMIT 1
     ) t ON true
     WHERE a.gym_id = $1 AND a.trainer_staff_id = $2 AND a.status = 'ACTIVE'
     ORDER BY gm.first_name`,
    [gymId, trainerStaffId]
  );
  return rows;
}

module.exports = {
  countActiveAssignments, listAssignableTrainers,
  assignTrainer, endTrainerAssignment,
  listMemberTrainerAssignments, listGymTrainerAssignments, listAssignedMembersForTrainer,
};
