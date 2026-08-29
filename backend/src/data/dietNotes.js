// dietNotes.js — lightweight trainer→client nutrition notes (migration 038).
// A note has: author (trainer), client, optional plan + date, timestamp and
// a read receipt. Kept deliberately minimal — no threads, no types.
const { query } = require('../db/pool');
const coaching = require('./coachingPlans');
const { assertActiveAssociation } = require('./assignedPlans');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);

async function createNote(trainerId, clientId, { note, note_date, plan_id }) {
  if (!note || !String(note).trim()) throw new HttpError(400, 'note is required');
  await assertActiveAssociation(trainerId, clientId);
  if (plan_id) {
    // notes may only reference a plan the trainer actually assigned
    const { rows } = await query(
      'SELECT 1 FROM diet_plans WHERE id = $1 AND trainer_id = $2 AND client_id = $3',
      [plan_id, trainerId, clientId]
    );
    if (!rows.length) throw new HttpError(404, 'Plan not found');
  }
  const { rows } = await query(
    `INSERT INTO diet_trainer_notes (trainer_id, client_id, plan_id, note_date, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [trainerId, clientId, plan_id || null, cleanDate(note_date), String(note).trim()]
  );
  return rows[0];
}

async function listNotesForTrainer(trainerId, clientId) {
  await coaching.assertReadableAssociation(trainerId, clientId);
  const { rows } = await query(
    `SELECT n.*, u.name AS client_name
     FROM diet_trainer_notes n JOIN users u ON u.id = n.client_id
     WHERE n.trainer_id = $1 AND n.client_id = $2
     ORDER BY n.created_at DESC LIMIT 50`,
    [trainerId, clientId]
  );
  return rows;
}

// Client view: only the active trainer's notes (relationship-gated).
async function listNotesForClient(clientId) {
  const { rows } = await query(
    `SELECT n.*, u.name AS trainer_name
     FROM diet_trainer_notes n JOIN users u ON u.id = n.trainer_id
     WHERE n.client_id = $1
       AND EXISTS (SELECT 1 FROM trainer_clients tc
                   WHERE tc.trainer_id = n.trainer_id AND tc.client_id = $1
                     AND tc.status IN ('active','archived'))
     ORDER BY n.created_at DESC LIMIT 50`,
    [clientId]
  );
  return rows;
}

async function markNoteRead(clientId, noteId) {
  const { rows } = await query(
    `UPDATE diet_trainer_notes SET read_at = now()
     WHERE id = $1 AND client_id = $2 AND read_at IS NULL
     RETURNING *`,
    [noteId, clientId]
  );
  if (!rows.length) throw new HttpError(404, 'Note not found');
  return rows[0];
}

module.exports = { createNote, listNotesForTrainer, listNotesForClient, markNoteRead };
