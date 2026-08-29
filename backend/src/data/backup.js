// Data access for the full-fidelity backup system (System 3). ONE module
// owns every backup entity so upload and restore share the same entity
// definitions — never two drifting implementations.
//
// Conventions:
//  - Upserts keyed on (user_id, local_entity_id) → last-write-wins on
//    server-received timestamp (accepted simplification, per README).
//  - Parent-child linkage uses the parent's local_entity_id.
//  - Exercise references are stored BY NAME (local ids aren't portable).
//  - Deletes are IDEMPOTENT — a queued delete must never 404-loop.
//  - Routines wrap client_workout_plans and measurements wrap
//    measurement_entries (existing correct tables — no duplicates).
//    Sessions use NEW full-fidelity tables, separate from the redacted
//    trainer-facing sync. Never merge the two session systems.
const { query, transaction } = require('../db/pool');
const templates = require('./workoutTemplatesSync');
const measurementsData = require('./measurements');
const dietAlternatives = require('./dietAlternatives');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sinceClause = (since) => (since ? 'AND updated_at > $2' : '');




async function upsertCustomExercises(userId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of list) {
    if (!e || !e.local_entity_id || !e.name) {
      throw new HttpError(400, 'Each exercise requires local_entity_id and name');
    }
    const { rows: r } = await query(
      `INSERT INTO backup_custom_exercises
         (user_id, local_entity_id, name, muscle_group, instructions, thumbnail_path, equipment, body_part)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, muscle_group = EXCLUDED.muscle_group,
         instructions = EXCLUDED.instructions, thumbnail_path = EXCLUDED.thumbnail_path,
         equipment = EXCLUDED.equipment, body_part = EXCLUDED.body_part,
         updated_at = now()
       RETURNING *`,
      [userId, String(e.local_entity_id), e.name, e.muscle_group || 'other',
       e.instructions ?? null, e.thumbnail_path ?? null, e.equipment ?? null, e.body_part ?? null]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function deleteCustomExercise(userId, localId) {
  await query('DELETE FROM backup_custom_exercises WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

async function listCustomExercises(userId, since) {
  const { rows } = await query(
    `SELECT * FROM backup_custom_exercises WHERE user_id = $1 ${sinceClause(since)} ORDER BY name`,
    since ? [userId, since] : [userId]
  );
  return rows;
}

// ── Workout plans (wraps client_workout_plans) ──────────────────────────
async function deleteWorkoutPlan(userId, localId) {
  await query('DELETE FROM client_workout_plans WHERE client_id = $1 AND local_plan_id = $2', [userId, String(localId)]);
  return { ok: true };
}

// ── Sessions (full fidelity) ────────────────────────────────────────────
async function upsertSession(userId, p) {
  if (!p || !p.local_entity_id || !p.started_at) {
    throw new HttpError(400, 'Session requires local_entity_id and started_at');
  }
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO backup_sessions
         (user_id, local_entity_id, name, started_at, finished_at, duration_seconds,
          notes, plan_local_id, source_assigned_plan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at, duration_seconds = EXCLUDED.duration_seconds,
         notes = EXCLUDED.notes, plan_local_id = EXCLUDED.plan_local_id,
         source_assigned_plan_id = EXCLUDED.source_assigned_plan_id, updated_at = now()
       RETURNING *`,
      [userId, String(p.local_entity_id), p.name || 'Workout', p.started_at, p.finished_at ?? null,
       p.duration_seconds ?? null, p.notes ?? null, p.plan_local_id ?? null, p.source_assigned_plan_id ?? null]
    );
    const sid = String(p.local_entity_id);
    await client.query('DELETE FROM backup_session_exercises WHERE user_id = $1 AND session_local_id = $2', [userId, sid]);
    for (let i = 0; i < (p.exercises || []).length; i++) {
      const ex = p.exercises[i] || {};
      const exLocal = String(ex.local_entity_id ?? `${sid}:e${i}`);
      await client.query(
        `INSERT INTO backup_session_exercises
           (user_id, local_entity_id, session_local_id, exercise_name, muscle_group,
            order_index, rest_seconds, group_id, notes, trainer_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [userId, exLocal, sid, String(ex.exercise_name || ''), ex.muscle_group ?? null,
         ex.order_index ?? i, ex.rest_seconds ?? null, ex.group_id ?? null, ex.notes ?? null,
         ex.trainerNote ?? null]
      );
      for (let j = 0; j < (ex.sets || []).length; j++) {
        const s = ex.sets[j] || {};
        await client.query(
          `INSERT INTO backup_sets
             (user_id, local_entity_id, session_exercise_local_id, weight, reps,
              set_type, rpe, completed, order_index)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [userId, String(s.local_entity_id ?? `${exLocal}:s${j}`), exLocal,
           Number(s.weight) || 0, Number(s.reps) || 0, s.set_type || 'working',
           s.rpe ?? null, s.completed !== false, s.order_index ?? j]
        );
      }
    }
    return rows[0];
  });
}

async function deleteSession(userId, localId) {
  await query('DELETE FROM backup_sessions WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

async function listSessions(userId, since) {
  const { rows: sessions } = await query(
    `SELECT * FROM backup_sessions WHERE user_id = $1 ${sinceClause(since)} ORDER BY started_at ASC`,
    since ? [userId, since] : [userId]
  );
  if (!sessions.length) return [];
  const { rows: exs } = await query(
    'SELECT * FROM backup_session_exercises WHERE user_id = $1 ORDER BY session_local_id, order_index', [userId]);
  const { rows: sets } = await query(
    'SELECT * FROM backup_sets WHERE user_id = $1 ORDER BY session_exercise_local_id, order_index', [userId]);
  const setsByEx = new Map();
  for (const s of sets) {
    if (!setsByEx.has(s.session_exercise_local_id)) setsByEx.set(s.session_exercise_local_id, []);
    setsByEx.get(s.session_exercise_local_id).push(s);
  }
  const exsBySession = new Map();
  for (const e of exs) {
    if (!exsBySession.has(e.session_local_id)) exsBySession.set(e.session_local_id, []);
    exsBySession.get(e.session_local_id).push({ ...e, sets: setsByEx.get(e.local_entity_id) || [] });
  }
  for (const s of sessions) s.exercises = exsBySession.get(s.local_entity_id) || [];
  return sessions;
}

// ── Diet plans (nested) ─────────────────────────────────────────────────
async function upsertDietPlan(userId, p) {
  if (!p || !p.local_entity_id || !p.name) throw new HttpError(400, 'Diet plan requires local_entity_id and name');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO backup_diet_plans
         (user_id, local_entity_id, name, notes, tags,
          daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target,
          tracking_mode, tolerance_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, notes = EXCLUDED.notes, tags = EXCLUDED.tags,
         daily_calorie_target = EXCLUDED.daily_calorie_target,
         daily_protein_target = EXCLUDED.daily_protein_target,
         daily_carbs_target = EXCLUDED.daily_carbs_target,
         daily_fat_target = EXCLUDED.daily_fat_target,
         tracking_mode = EXCLUDED.tracking_mode,
         tolerance_pct = EXCLUDED.tolerance_pct, updated_at = now()
       RETURNING *`,
      [userId, String(p.local_entity_id), p.name, p.notes ?? null, p.tags || [],
       p.daily_calorie_target ?? null, p.daily_protein_target ?? null,
       p.daily_carbs_target ?? null, p.daily_fat_target ?? null,
       p.tracking_mode === 'detailed' ? 'detailed' : 'simple',
       Number.isFinite(Number(p.tolerance_pct)) && Number(p.tolerance_pct) >= 1 && Number(p.tolerance_pct) <= 50
         ? Math.round(Number(p.tolerance_pct)) : 10]
    );
    const pid = String(p.local_entity_id);
    await client.query('DELETE FROM backup_diet_plan_days WHERE user_id = $1 AND diet_plan_local_id = $2', [userId, pid]);
    for (let di = 0; di < (p.days || []).length; di++) {
      const d = p.days[di] || {};
      const dayLocal = String(d.local_entity_id ?? `${pid}:d${di}`);
      await client.query(
        `INSERT INTO backup_diet_plan_days (user_id, local_entity_id, diet_plan_local_id, day_label, order_index)
         VALUES ($1,$2,$3,$4,$5)`,
        [userId, dayLocal, pid, d.day_label ?? `Day ${di + 1}`, d.order_index ?? di]
      );
      for (let mi = 0; mi < (d.meals || []).length; mi++) {
        const m = d.meals[mi] || {};
        const mealLocal = String(m.local_entity_id ?? `${dayLocal}:m${mi}`);
        await client.query(
          `INSERT INTO backup_diet_plan_meals (user_id, local_entity_id, diet_day_local_id, meal_type, order_index, slot_note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, mealLocal, dayLocal, m.meal_type || 'meal', m.order_index ?? mi, m.slot_note ?? null]
        );
        for (let ii = 0; ii < (m.items || []).length; ii++) {
          const it = m.items[ii] || {};
          // configured dish alternatives ride INSIDE the item payload
          // (validated: max 3, no duplicates — never truncated)
          const altList = dietAlternatives.normalizeDietItemAlternatives(it.name, it.alternatives)
            .map((a) => ({
              name: a.alternative_name,
              calories: a.alternative_calories,
              protein_g: a.alternative_protein_g,
              carbs_g: a.alternative_carbs_g,
              fat_g: a.alternative_fat_g,
              recipe_local_id: a.alternative_catalog_item_id || null,
            }));
          await client.query(
            `INSERT INTO backup_diet_plan_meal_items
               (user_id, local_entity_id, diet_meal_local_id, local_recipe_id, name, calories,
                protein_g, carbs_g, fat_g, serving_size, recipe_url, quantity_multiplier,
                client_note, order_index, photo_path, ingredients, allergens, prep_time_minutes,
                cook_time_minutes, difficulty, alternate_servings, tags, alternatives)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                     $23::jsonb)`,
            [userId, String(it.local_entity_id ?? `${mealLocal}:i${ii}`), mealLocal,
             it.local_recipe_id ? String(it.local_recipe_id) : null, String(it.name || 'Item'),
             it.calories ?? null, it.protein_g ?? null, it.carbs_g ?? null, it.fat_g ?? null,
             it.serving_size ?? null, it.recipe_url ?? null, it.quantity_multiplier ?? 1,
             it.client_note ?? null, it.order_index ?? ii, it.photo_path ?? null,
             it.ingredients || [], it.allergens || [], it.prep_time_minutes ?? null,
             it.cook_time_minutes ?? null, it.difficulty ?? null,
             JSON.stringify(it.alternate_servings || []), it.tags || [],
             JSON.stringify(altList)]
          );
        }
      }
    }
    return rows[0];
  });
}

async function deleteDietPlan(userId, localId) {
  await query('DELETE FROM backup_diet_checkins WHERE user_id = $1 AND diet_plan_local_id = $2', [userId, String(localId)]);
  // the client's deleteDietPlan removes diary rows locally; cascade here too
  await query('DELETE FROM backup_food_log_entries WHERE user_id = $1 AND plan_ref = $2', [userId, String(localId)]);
  await query('DELETE FROM backup_diet_plans WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

async function listDietPlans(userId, since) {
  const { rows: plans } = await query(
    `SELECT * FROM backup_diet_plans WHERE user_id = $1 ${sinceClause(since)} ORDER BY created_at ASC`,
    since ? [userId, since] : [userId]
  );
  if (!plans.length) return [];
  const { rows: days } = await query(
    'SELECT * FROM backup_diet_plan_days WHERE user_id = $1 ORDER BY diet_plan_local_id, order_index', [userId]);
  const { rows: meals } = await query(
    'SELECT * FROM backup_diet_plan_meals WHERE user_id = $1 ORDER BY diet_day_local_id, order_index', [userId]);
  const { rows: items } = await query(
    'SELECT * FROM backup_diet_plan_meal_items WHERE user_id = $1 ORDER BY diet_meal_local_id, order_index', [userId]);
  const itemsByMeal = new Map();
  for (const it of items) {
    if (!itemsByMeal.has(it.diet_meal_local_id)) itemsByMeal.set(it.diet_meal_local_id, []);
    itemsByMeal.get(it.diet_meal_local_id).push(it);
  }
  const mealsByDay = new Map();
  for (const m of meals) {
    if (!mealsByDay.has(m.diet_day_local_id)) mealsByDay.set(m.diet_day_local_id, []);
    mealsByDay.get(m.diet_day_local_id).push({ ...m, items: itemsByMeal.get(m.local_entity_id) || [] });
  }
  const daysByPlan = new Map();
  for (const d of days) {
    if (!daysByPlan.has(d.diet_plan_local_id)) daysByPlan.set(d.diet_plan_local_id, []);
    daysByPlan.get(d.diet_plan_local_id).push({ ...d, meals: mealsByDay.get(d.local_entity_id) || [] });
  }
  for (const p of plans) p.days = daysByPlan.get(p.local_entity_id) || [];
  return plans;
}

async function upsertDietCheckins(userId, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of entries) {
    if (!e || !e.diet_plan_local_id || !e.date || e.followed == null) {
      throw new HttpError(400, 'Each check-in requires diet_plan_local_id, date and followed');
    }
    const { rows: r } = await query(
      `INSERT INTO backup_diet_checkins (user_id, diet_plan_local_id, date, followed, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, diet_plan_local_id, date) DO UPDATE SET
         followed = EXCLUDED.followed, note = EXCLUDED.note, updated_at = now()
       RETURNING *`,
      [userId, String(e.diet_plan_local_id), e.date, !!e.followed, e.note ?? null]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listDietCheckins(userId, planLocalId) {
  const { rows } = await query(
    `SELECT * FROM backup_diet_checkins WHERE user_id = $1
       AND ($2::text IS NULL OR diet_plan_local_id = $2) ORDER BY date ASC`,
    [userId, planLocalId || null]
  );
  return rows;
}

// ── Diet item swaps (date-scoped substitutions) ─────────────────────────
// Every swap is privately backed up here regardless of plan type. Trainer
// visibility is a SEPARATE concern handled by plan_server_id (set only for
// trainer-assigned plans): self-authored swaps are stored but never
// surfaced through any trainer route.
async function upsertDietSwaps(userId, entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new HttpError(400, 'Body must be a non-empty array');
  }
  const rows = [];
  for (const e of entries) {
    if (!e || !e.plan_ref || !e.diet_plan_meal_item_ref || !e.swap_date ||
        !e.swapped_name || !e.original_name) {
      throw new HttpError(
        400,
        'Each swap requires plan_ref, diet_plan_meal_item_ref, swap_date, original_name and swapped_name'
      );
    }
    const { rows: r } = await query(
      `INSERT INTO diet_item_swaps
         (user_id, plan_ref, plan_server_id, diet_plan_meal_item_ref, swap_date,
          original_name, swapped_name, swapped_calories, swapped_protein_g,
          swapped_carbs_g, swapped_fat_g)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, diet_plan_meal_item_ref, swap_date) DO UPDATE SET
         plan_ref = EXCLUDED.plan_ref,
         plan_server_id = EXCLUDED.plan_server_id,
         original_name = EXCLUDED.original_name,
         swapped_name = EXCLUDED.swapped_name,
         swapped_calories = EXCLUDED.swapped_calories,
         swapped_protein_g = EXCLUDED.swapped_protein_g,
         swapped_carbs_g = EXCLUDED.swapped_carbs_g,
         swapped_fat_g = EXCLUDED.swapped_fat_g,
         updated_at = now()
       RETURNING *`,
      [userId, String(e.plan_ref), e.plan_server_id ? String(e.plan_server_id) : null,
       String(e.diet_plan_meal_item_ref), e.swap_date, String(e.original_name),
       String(e.swapped_name), e.swapped_calories ?? null, e.swapped_protein_g ?? null,
       e.swapped_carbs_g ?? null, e.swapped_fat_g ?? null]
    );
    rows.push(r[0]);
  }
  return rows;
}

// Idempotent — an undo of a swap that never synced must not 404-loop.
async function deleteDietSwap(userId, itemRef, date) {
  await query(
    'DELETE FROM diet_item_swaps WHERE user_id = $1 AND diet_plan_meal_item_ref = $2 AND swap_date = $3',
    [userId, String(itemRef), date]
  );
  return { ok: true };
}

async function listDietSwaps(userId, since) {
  const { rows } = await query(
    `SELECT * FROM diet_item_swaps WHERE user_id = $1 ${sinceClause(since)} ORDER BY swap_date DESC`,
    since ? [userId, since] : [userId]
  );
  return rows;
}

// Trainer-facing "Recent substitutions" for ONE assigned plan. Ownership is
// enforced by joining diet_plans (trainer_id + client_id). Swaps on
// SELF-AUTHORED plans have plan_server_id IS NULL and can never match.
async function listAssignedPlanSwaps(trainerId, clientId, planId, limit = 30) {
  const { rows } = await query(
    `SELECT s.* FROM diet_item_swaps s
     JOIN diet_plans p ON p.id = s.plan_server_id::uuid
     WHERE p.id = $3::uuid AND p.trainer_id = $1 AND p.client_id = $2
     ORDER BY s.swap_date DESC, s.created_at DESC LIMIT $4`,
    [trainerId, clientId, String(planId), limit]
  );
  return rows;
}

// ── Supplement plans (nested) ───────────────────────────────────────────
async function upsertSupplementPlan(userId, p) {
  if (!p || !p.local_entity_id || !p.name) throw new HttpError(400, 'Supplement plan requires local_entity_id and name');
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO backup_supplement_plans (user_id, local_entity_id, name, notes, tags)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, notes = EXCLUDED.notes, tags = EXCLUDED.tags, updated_at = now()
       RETURNING *`,
      [userId, String(p.local_entity_id), p.name, p.notes ?? null, p.tags || []]
    );
    const pid = String(p.local_entity_id);
    await client.query('DELETE FROM backup_supplement_plan_items WHERE user_id = $1 AND supplement_plan_local_id = $2', [userId, pid]);
    for (let i = 0; i < (p.items || []).length; i++) {
      const it = p.items[i] || {};
      await client.query(
        `INSERT INTO backup_supplement_plan_items
           (user_id, local_entity_id, supplement_plan_local_id, supplement_name, dosage, timing, notes, order_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, String(it.local_entity_id ?? `${pid}:i${i}`), pid, String(it.supplement_name || 'Supplement'),
         it.dosage ?? null, it.timing ?? null, it.notes ?? null, it.order_index ?? i]
      );
    }
    return rows[0];
  });
}

async function deleteSupplementPlan(userId, localId) {
  await query('DELETE FROM backup_supplement_checkins WHERE user_id = $1 AND supplement_plan_local_id = $2', [userId, String(localId)]);
  await query('DELETE FROM backup_supplement_plans WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

async function listSupplementPlans(userId, since) {
  const { rows: plans } = await query(
    `SELECT * FROM backup_supplement_plans WHERE user_id = $1 ${sinceClause(since)} ORDER BY created_at ASC`,
    since ? [userId, since] : [userId]
  );
  if (!plans.length) return [];
  const { rows: items } = await query(
    'SELECT * FROM backup_supplement_plan_items WHERE user_id = $1 ORDER BY supplement_plan_local_id, order_index', [userId]);
  const byPlan = new Map();
  for (const it of items) {
    if (!byPlan.has(it.supplement_plan_local_id)) byPlan.set(it.supplement_plan_local_id, []);
    byPlan.get(it.supplement_plan_local_id).push(it);
  }
  for (const p of plans) p.items = byPlan.get(p.local_entity_id) || [];
  return plans;
}

async function upsertSupplementCheckins(userId, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of entries) {
    if (!e || !e.supplement_plan_local_id || !e.date || e.taken == null) {
      throw new HttpError(400, 'Each check-in requires supplement_plan_local_id, date and taken');
    }
    const { rows: r } = await query(
      `INSERT INTO backup_supplement_checkins (user_id, supplement_plan_local_id, date, taken, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, supplement_plan_local_id, date) DO UPDATE SET
         taken = EXCLUDED.taken, note = EXCLUDED.note, updated_at = now()
       RETURNING *`,
      [userId, String(e.supplement_plan_local_id), e.date, !!e.taken, e.note ?? null]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listSupplementCheckins(userId, planLocalId) {
  const { rows } = await query(
    `SELECT * FROM backup_supplement_checkins WHERE user_id = $1
       AND ($2::text IS NULL OR supplement_plan_local_id = $2) ORDER BY date ASC`,
    [userId, planLocalId || null]
  );
  return rows;
}

// ── Personal records (literal rows, per D2) ─────────────────────────────
async function upsertPersonalRecords(userId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const r0 of list) {
    if (!r0 || !r0.local_entity_id || !r0.exercise_name || !r0.record_type || r0.value == null) {
      throw new HttpError(400, 'Each record requires local_entity_id, exercise_name, record_type and value');
    }
    const { rows: r } = await query(
      `INSERT INTO backup_personal_records
         (user_id, local_entity_id, exercise_name, record_type, value, secondary_value, achieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         exercise_name = EXCLUDED.exercise_name, record_type = EXCLUDED.record_type,
         value = EXCLUDED.value, secondary_value = EXCLUDED.secondary_value,
         achieved_at = EXCLUDED.achieved_at, updated_at = now()
       RETURNING *`,
      [userId, String(r0.local_entity_id), r0.exercise_name, r0.record_type,
       Number(r0.value), r0.secondary_value ?? null, r0.achieved_at ?? null]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function deletePersonalRecord(userId, localId) {
  await query('DELETE FROM backup_personal_records WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

async function listPersonalRecords(userId, since) {
  const { rows } = await query(
    `SELECT * FROM backup_personal_records WHERE user_id = $1 ${sinceClause(since)} ORDER BY achieved_at ASC`,
    since ? [userId, since] : [userId]
  );
  return rows;
}

// ── Recipes (real feature table + sync upserts) ─────────────────────────
async function upsertRecipes(userId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Body must be a non-empty array');
  const rows = [];
  for (const e of list) {
    if (!e || !e.local_entity_id || !e.name) throw new HttpError(400, 'Each recipe requires local_entity_id and name');
    const { rows: r } = await query(
      `INSERT INTO user_recipes
         (user_id, local_entity_id, name, description, prep_notes, calories, protein_g, carbs_g, fat_g,
          serving_size, recipe_url, photo_path, ingredients, allergens, prep_time_minutes,
          cook_time_minutes, difficulty, suggested_meal_types, is_favorite, alternate_servings, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, prep_notes = EXCLUDED.prep_notes,
         calories = EXCLUDED.calories, protein_g = EXCLUDED.protein_g, carbs_g = EXCLUDED.carbs_g,
         fat_g = EXCLUDED.fat_g, serving_size = EXCLUDED.serving_size, recipe_url = EXCLUDED.recipe_url,
         photo_path = EXCLUDED.photo_path, ingredients = EXCLUDED.ingredients, allergens = EXCLUDED.allergens,
         prep_time_minutes = EXCLUDED.prep_time_minutes, cook_time_minutes = EXCLUDED.cook_time_minutes,
         difficulty = EXCLUDED.difficulty, suggested_meal_types = EXCLUDED.suggested_meal_types,
         is_favorite = EXCLUDED.is_favorite, alternate_servings = EXCLUDED.alternate_servings,
         tags = EXCLUDED.tags, updated_at = now()
       RETURNING *`,
      [userId, String(e.local_entity_id), e.name, e.description ?? null, e.prep_notes ?? null,
       e.calories ?? null, e.protein_g ?? null, e.carbs_g ?? null, e.fat_g ?? null,
       e.serving_size ?? null, e.recipe_url ?? null, e.photo_path ?? null,
       e.ingredients || [], e.allergens || [], e.prep_time_minutes ?? null,
       e.cook_time_minutes ?? null, e.difficulty ?? null, e.suggested_meal_types || [],
       e.is_favorite === true, JSON.stringify(e.alternate_servings || []), e.tags || []]
    );
    rows.push(r[0]);
  }
  return rows;
}

async function listRecipes(userId) {
  const { rows } = await query('SELECT * FROM user_recipes WHERE user_id = $1 ORDER BY name', [userId]);
  return rows;
}

async function getRecipeById(userId, id) {
  const { rows } = await query('SELECT * FROM user_recipes WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] || null;
}

async function updateRecipeById(userId, id, patch) {
  const existing = await getRecipeById(userId, id);
  if (!existing) throw new HttpError(404, 'Recipe not found');
  const merged = { ...existing, ...patch, id: existing.id, user_id: userId };
  const { rows } = await query(
    `UPDATE user_recipes SET name = $3, description = $4, prep_notes = $5, calories = $6,
       protein_g = $7, carbs_g = $8, fat_g = $9, serving_size = $10, recipe_url = $11,
       photo_path = $12, ingredients = $13, allergens = $14, prep_time_minutes = $15,
       cook_time_minutes = $16, difficulty = $17, suggested_meal_types = $18,
       is_favorite = $19, alternate_servings = $20, tags = $21, updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id, merged.name, merged.description ?? null, merged.prep_notes ?? null,
     merged.calories ?? null, merged.protein_g ?? null, merged.carbs_g ?? null, merged.fat_g ?? null,
     merged.serving_size ?? null, merged.recipe_url ?? null, merged.photo_path ?? null,
     merged.ingredients || [], merged.allergens || [], merged.prep_time_minutes ?? null,
     merged.cook_time_minutes ?? null, merged.difficulty ?? null, merged.suggested_meal_types || [],
     merged.is_favorite === true, JSON.stringify(merged.alternate_servings || []), merged.tags || []]
  );
  return rows[0];
}

async function deleteRecipeById(userId, id) {
  const { rowCount } = await query('DELETE FROM user_recipes WHERE user_id = $1 AND id = $2', [userId, id]);
  if (rowCount === 0) throw new HttpError(404, 'Recipe not found');
  return { ok: true };
}

async function deleteRecipeByLocalId(userId, localId) {
  await query('DELETE FROM user_recipes WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true };
}

// ── Measurements (wraps measurement_entries) ────────────────────────────
async function deleteMeasurement(userId, date, metricType) {
  await query('DELETE FROM measurement_entries WHERE client_id = $1 AND date = $2 AND metric_type = $3',
    [userId, date, metricType]);
  return { ok: true };
}

// ── Progress photos (metadata; files via storageService) ────────────────
async function upsertProgressPhoto(userId, p) {
  if (!p || !p.local_entity_id || !p.date || !p.storage_key) {
    throw new HttpError(400, 'Photo requires local_entity_id, date and storage_key');
  }
  const { rows } = await query(
    `INSERT INTO backup_progress_photos (user_id, local_entity_id, date, angle, storage_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, local_entity_id) DO UPDATE SET
       date = EXCLUDED.date, angle = EXCLUDED.angle, storage_key = EXCLUDED.storage_key, updated_at = now()
     RETURNING *`,
    [userId, String(p.local_entity_id), p.date, p.angle ?? null, p.storage_key]
  );
  return rows[0];
}

async function listProgressPhotos(userId) {
  const { rows } = await query('SELECT * FROM backup_progress_photos WHERE user_id = $1 ORDER BY date ASC', [userId]);
  return rows;
}

async function deleteProgressPhoto(userId, localId) {
  const { rows } = await query(
    'SELECT storage_key FROM backup_progress_photos WHERE user_id = $1 AND local_entity_id = $2',
    [userId, String(localId)]
  );
  await query('DELETE FROM backup_progress_photos WHERE user_id = $1 AND local_entity_id = $2', [userId, String(localId)]);
  return { ok: true, storage_key: rows[0]?.storage_key || null };
}

// ── Summary (cheap restore-precheck) ────────────────────────────────────
async function backupSummary(userId) {
    const one = async (sql) => Number((await query(sql, [userId])).rows[0].c);
  return {
    custom_exercises: await one('SELECT COUNT(*) AS c FROM backup_custom_exercises WHERE user_id = $1'),
    workout_plans: await one('SELECT COUNT(*) AS c FROM client_workout_plans WHERE client_id = $1'),
    sessions: await one('SELECT COUNT(*) AS c FROM backup_sessions WHERE user_id = $1'),
    recipes: await one('SELECT COUNT(*) AS c FROM user_recipes WHERE user_id = $1'),
    diet_plans: await one('SELECT COUNT(*) AS c FROM backup_diet_plans WHERE user_id = $1'),
    diet_item_swaps: await one('SELECT COUNT(*) AS c FROM diet_item_swaps WHERE user_id = $1'),
    supplement_plans: await one('SELECT COUNT(*) AS c FROM backup_supplement_plans WHERE user_id = $1'),
    measurements: await one('SELECT COUNT(*) AS c FROM measurement_entries WHERE client_id = $1'),
    personal_records: await one('SELECT COUNT(*) AS c FROM backup_personal_records WHERE user_id = $1'),
    progress_photos: await one('SELECT COUNT(*) AS c FROM backup_progress_photos WHERE user_id = $1'),
  };
}

module.exports = {
  upsertCustomExercises, deleteCustomExercise, listCustomExercises,
  deleteWorkoutPlan,
  upsertSession, deleteSession, listSessions,
  upsertDietPlan, deleteDietPlan, listDietPlans, upsertDietCheckins, listDietCheckins,
  upsertDietSwaps, deleteDietSwap, listDietSwaps, listAssignedPlanSwaps,
  upsertSupplementPlan, deleteSupplementPlan, listSupplementPlans, upsertSupplementCheckins, listSupplementCheckins,
  upsertPersonalRecords, deletePersonalRecord, listPersonalRecords,
  upsertRecipes, listRecipes, getRecipeById, updateRecipeById, deleteRecipeById, deleteRecipeByLocalId,
  deleteMeasurement,
  upsertProgressPhoto, listProgressPhotos, deleteProgressPhoto,
  backupSummary,
  templates, // re-exported wrapper targets
  measurementsData,
};