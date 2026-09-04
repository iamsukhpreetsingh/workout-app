// gymCommunications.js — gym announcements & fan-out (Phase 14).
//
// A gym can only ever talk to ITS OWN members: every row is gym-scoped and
// audience resolution happens at SEND TIME against current membership status
// (a member added after create but before send still receives it; a member
// who left before send never does).
//
// LIFECYCLE (gym_announcements.status):
//   DRAFT → SCHEDULED (scheduled_for set) → SENT   when due (dispatchDue)
//   DRAFT → SENT immediately                       (publishAnnouncement)
//   DRAFT/SCHEDULED → CANCELLED                    (cancelAnnouncement)
//   SENT is terminal — re-publishing is a 409 and the per-recipient dedupe
//   key (announcement:member:channel UNIQUE) makes double delivery
//   impossible even under races; a crash mid-dispatch leaves QUEUED rows
//   that the next dispatch tick completes.
//
// CHANNELS (one delivery row per announcement × member × channel, the
// honest ledger of what actually happened):
//   IN_APP  app-connected members → a row in the existing notifications
//           table (type 'gym_announcement'), visible in the app inbox even
//           without a push token.
//   PUSH    app-connected members WITH a registered Expo token → a real
//           Expo push send. No token → SKIPPED 'no_push_token' (never faked).
//   EMAIL   non-app members ONLY (the app channel is push/in-app) →
//           attempted when the member has an email AND SMTP is configured;
//           no email → SKIPPED 'no_email_address'; no SMTP →
//           SKIPPED 'email_not_configured'; transport error → FAILED.
//   A member who goes CANCELLED between queueing and sending is SKIPPED
//   'member_inactive_at_send'.
//
// TIME: scheduled_for is stored as an ABSOLUTE instant (timestamptz) but the
// API accepts a GYM-LOCAL wall time ("YYYY-MM-DD HH:mm") and converts with
// the gym's timezone — a New Delhi gym schedules in IST no matter where the
// server runs. Due dispatch is a plain comparison against now(); no cron
// math — call dispatchDue() from any ticker (or the staff route).
const { query, transaction } = require('../db/pool');
const smtpProvider = require('../email/smtpProvider');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const AUDIENCE_TYPES = ['ALL_ACTIVE_MEMBERS', 'SPECIFIC_MEMBERS', 'SPECIFIC_BRANCH'];
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "member who belongs" for audience purposes — CANCELLED means they left
const ACTIVE_SQL = "status <> 'CANCELLED'";

// ── gym-timezone wall-time ⇄ absolute instant ──────────────────────────────
function tzOffsetMs(instant, timeZone) {
  const map = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour) % 24, Number(map.minute), Number(map.second)
  );
  return asUTC - instant.getTime();
}

// "YYYY-MM-DD HH:mm" (gym-local wall time) → absolute Date
function wallToInstant(wall, timeZone, field = 'scheduled_for') {
  const m = WALL_RE.exec(String(wall || '').trim());
  if (!m) throw new HttpError(400, `${field} must be "YYYY-MM-DD HH:mm" (gym-local time)`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = guess - tzOffsetMs(new Date(guess), timeZone);
  ms = guess - tzOffsetMs(new Date(ms), timeZone); // second pass fixes DST edges
  return new Date(ms);
}

// absolute Date → "YYYY-MM-DD HH:mm" in the gym's timezone (display only)
function instantToWall(instant, timeZone) {
  const map = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant)) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${String(map.hour % 24).padStart(2, '0')}:${map.minute}`;
}

async function gymTz(client, gymId) {
  const { rows } = await client.query('SELECT timezone FROM gyms WHERE id = $1', [gymId]);
  if (!rows.length) throw new HttpError(404, 'Gym not found');
  return rows[0].timezone;
}

// ── payload validation ─────────────────────────────────────────────────────
function cleanTitle(v) {
  const s = String(v ?? '').trim();
  if (s.length < 1 || s.length > 200) throw new HttpError(400, 'title must be 1-200 characters');
  return s;
}
function cleanBody(v) {
  const s = String(v ?? '').trim();
  if (s.length < 1 || s.length > 5000) throw new HttpError(400, 'body must be 1-5000 characters');
  return s;
}

async function cleanAudience(client, gymId, payload) {
  const type = String(payload.audience_type || '').toUpperCase();
  if (!AUDIENCE_TYPES.includes(type)) {
    throw new HttpError(400, `audience_type must be one of ${AUDIENCE_TYPES.join(', ')}`);
  }
  const ids = payload.audience_member_ids ?? null;
  const branch = payload.audience_branch ?? null;
  if (type === 'ALL_ACTIVE_MEMBERS') {
    if (ids) throw new HttpError(400, 'audience_member_ids must not be set for ALL_ACTIVE_MEMBERS');
    if (branch) throw new HttpError(400, 'audience_branch must not be set for ALL_ACTIVE_MEMBERS');
    return { audience_type: type, audience_member_ids: null, audience_branch: null };
  }
  if (type === 'SPECIFIC_MEMBERS') {
    if (branch) throw new HttpError(400, 'audience_branch must not be set for SPECIFIC_MEMBERS');
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpError(400, 'audience_member_ids must be a non-empty array of member ids');
    }
    const clean = [];
    for (const id of ids) {
      const s = String(id);
      if (!UUID_RE.test(s)) throw new HttpError(400, `audience_member_ids contains an invalid id: ${s}`);
      clean.push(s);
    }
    const unique = [...new Set(clean)];
    // fail fast at create/edit: every listed id must be a member of THIS gym
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM gym_members WHERE gym_id = $1 AND id = ANY($2::uuid[])`,
      [gymId, unique]
    );
    if (rows[0].n !== unique.length) {
      throw new HttpError(400, 'One or more audience members do not belong to this gym');
    }
    return { audience_type: type, audience_member_ids: JSON.stringify(unique), audience_branch: null };
  }
  // SPECIFIC_BRANCH
  if (ids) throw new HttpError(400, 'audience_member_ids must not be set for SPECIFIC_BRANCH');
  const b = String(branch ?? '').trim();
  if (!b) throw new HttpError(400, 'audience_branch is required for SPECIFIC_BRANCH');
  return { audience_type: type, audience_member_ids: null, audience_branch: b.slice(0, 120) };
}

async function loadAnnouncement(client, gymId, id) {
  const { rows } = await client.query(
    'SELECT * FROM gym_announcements WHERE id = $1 AND gym_id = $2 FOR UPDATE',
    [id, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Announcement not found');
  return rows[0];
}

function withLocal(row, tz) {
  if (!row) return row;
  const out = { ...row };
  if (out.scheduled_for) out.scheduled_for_local = instantToWall(out.scheduled_for, tz);
  if (out.published_at) out.published_at_local = instantToWall(out.published_at, tz);
  return out;
}

// ── create (DRAFT, or SCHEDULED when scheduled_for is provided) ────────────
async function createAnnouncement(gymId, actor, ip, payload, gymAudit) {
  const title = cleanTitle(payload.title);
  const body = cleanBody(payload.body);
  return transaction(async (client) => {
    const tz = await gymTz(client, gymId);
    const audience = await cleanAudience(client, gymId, payload);
    let scheduled_for = null;
    let status = 'DRAFT';
    if (payload.scheduled_for != null && payload.scheduled_for !== '') {
      scheduled_for = wallToInstant(payload.scheduled_for, tz);
      status = 'SCHEDULED';
    }
    const { rows } = await client.query(
      `INSERT INTO gym_announcements
         (gym_id, title, body, audience_type, audience_member_ids, audience_branch,
          status, scheduled_for, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [gymId, title, body, audience.audience_type, audience.audience_member_ids,
       audience.audience_branch, status, scheduled_for, actor?.userId ?? null]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'announcement.created', entity: 'gym_announcement', entityId: rows[0].id,
      after: { title, audience_type: audience.audience_type, status,
               scheduled_for: payload.scheduled_for || null },
    });
    return withLocal(rows[0], tz);
  });
}

// ── edit (DRAFT/SCHEDULED only; SENT/CANCELLED are immutable) ──────────────
async function updateAnnouncement(gymId, id, actor, ip, patch, gymAudit) {
  return transaction(async (client) => {
    const tz = await gymTz(client, gymId);
    const before = await loadAnnouncement(client, gymId, id);
    if (before.status === 'SENT') throw new HttpError(409, 'Sent announcements are immutable');
    if (before.status === 'CANCELLED') throw new HttpError(409, 'Cancelled announcements are immutable');

    const next = {
      title: patch.title !== undefined ? cleanTitle(patch.title) : before.title,
      body: patch.body !== undefined ? cleanBody(patch.body) : before.body,
      audience_type: before.audience_type,
      audience_member_ids: before.audience_member_ids,
      audience_branch: before.audience_branch,
    };
    const audienceChanged = patch.audience_type !== undefined
      || patch.audience_member_ids !== undefined || patch.audience_branch !== undefined;
    if (audienceChanged) {
      const priorIds = typeof before.audience_member_ids === 'string'
        ? JSON.parse(before.audience_member_ids)
        : before.audience_member_ids; // pg hands JSONB back as a JS array
      const merged = {
        audience_type: patch.audience_type ?? before.audience_type,
        audience_member_ids: patch.audience_member_ids !== undefined
          ? patch.audience_member_ids
          : priorIds,
        audience_branch: patch.audience_branch !== undefined
          ? patch.audience_branch
          : before.audience_branch,
      };
      Object.assign(next, await cleanAudience(client, gymId, merged));
    }

    let scheduled_for = before.scheduled_for;
    let status = before.status;
    if (patch.scheduled_for !== undefined) {
      if (patch.scheduled_for == null || patch.scheduled_for === '') {
        if (before.status === 'SCHEDULED') {
          throw new HttpError(400, 'A scheduled announcement keeps its time — cancel it instead');
        }
        scheduled_for = null;
      } else {
        scheduled_for = wallToInstant(patch.scheduled_for, tz);
        if (before.status === 'DRAFT') status = 'SCHEDULED'; // DRAFT → SCHEDULED
      }
    }

    const { rows } = await client.query(
      `UPDATE gym_announcements
       SET title=$3, body=$4, audience_type=$5, audience_member_ids=$6, audience_branch=$7,
           status=$8, scheduled_for=$9, updated_at=now()
       WHERE id=$1 AND gym_id=$2 RETURNING *`,
      [id, gymId, next.title, next.body, next.audience_type, next.audience_member_ids,
       next.audience_branch, status, scheduled_for]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'announcement.updated', entity: 'gym_announcement', entityId: id,
      before: { title: before.title, status: before.status, audience_type: before.audience_type },
      after: { title: next.title, status, audience_type: next.audience_type,
               scheduled_for: patch.scheduled_for ?? undefined },
    });
    return withLocal(rows[0], tz);
  });
}

// ── cancel (DRAFT/SCHEDULED → CANCELLED) ───────────────────────────────────
async function cancelAnnouncement(gymId, id, actor, ip, { reason } = {}, gymAudit) {
  return transaction(async (client) => {
    const tz = await gymTz(client, gymId);
    const before = await loadAnnouncement(client, gymId, id);
    if (before.status === 'SENT') throw new HttpError(409, 'Sent announcements cannot be cancelled');
    if (before.status === 'CANCELLED') throw new HttpError(409, 'This announcement is already cancelled');
    const { rows } = await client.query(
      `UPDATE gym_announcements SET status='CANCELLED', updated_at=now()
       WHERE id=$1 AND gym_id=$2 RETURNING *`,
      [id, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'announcement.cancelled', entity: 'gym_announcement', entityId: id,
      before: { status: before.status }, after: { status: 'CANCELLED', reason: reason || null },
    });
    return withLocal(rows[0], tz);
  });
}

// ── audience resolution AT SEND TIME ───────────────────────────────────────
// Returns member rows {id, app_user_id, email, status}; SPECIFIC_MEMBERS
// keeps CANCELLED members (they surface as SKIPPED 'member_inactive_at_send'
// in the ledger), the broad audiences resolve against current membership.
async function resolveAudience(client, announcement) {
  if (announcement.audience_type === 'SPECIFIC_MEMBERS') {
    // the row value arrives as a JS array (pg parses JSONB) — accept both
    let ids = announcement.audience_member_ids;
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { ids = []; }
    }
    if (!Array.isArray(ids)) ids = [];
    const { rows } = await client.query(
      `SELECT id, app_user_id, email, status FROM gym_members
       WHERE gym_id = $1 AND id = ANY($2::uuid[])`,
      [announcement.gym_id, ids]
    );
    return rows;
  }
  if (announcement.audience_type === 'SPECIFIC_BRANCH') {
    const { rows } = await client.query(
      `SELECT id, app_user_id, email, status FROM gym_members
       WHERE gym_id = $1 AND ${ACTIVE_SQL} AND branch = $2`,
      [announcement.gym_id, announcement.audience_branch]
    );
    return rows;
  }
  const { rows } = await client.query(
    `SELECT id, app_user_id, email, status FROM gym_members
     WHERE gym_id = $1 AND ${ACTIVE_SQL}`,
    [announcement.gym_id]
  );
  return rows;
}

const dedupeKey = (announcementId, memberId, channel) =>
  `ann:${announcementId}:mbr:${memberId}:${channel}`;

// insert (or fetch) the delivery row; returns the row when it still owes a
// send (freshly inserted, or QUEUED from a crashed tick), else null
async function claimDelivery(client, announcement, memberId, channel) {
  const { rows } = await client.query(
    `INSERT INTO gym_announcement_deliveries
       (gym_id, announcement_id, member_id, channel, status, dedupe_key)
     VALUES ($1,$2,$3,$4,'QUEUED',$5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [announcement.gym_id, announcement.id, memberId, channel,
     dedupeKey(announcement.id, memberId, channel)]
  );
  if (rows.length) return { id: rows[0].id, status: 'QUEUED' };
  const { rows: existing } = await client.query(
    `SELECT id, status FROM gym_announcement_deliveries WHERE dedupe_key = $1 FOR UPDATE`,
    [dedupeKey(announcement.id, memberId, channel)]
  );
  if (existing.length && existing[0].status === 'QUEUED') {
    return { id: existing[0].id, status: 'QUEUED' }; // stranded by a crashed tick → retry
  }
  return null; // already SENT/FAILED/SKIPPED — dedupe holds
}

async function markDelivery(client, deliveryId, status, detail) {
  await client.query(
    `UPDATE gym_announcement_deliveries
     SET status=$2, detail=$3, sent_at=CASE WHEN $2='SENT' THEN now() ELSE sent_at END,
         updated_at=now()
     WHERE id=$1`,
    [deliveryId, status, detail ?? null]
  );
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function emailHtml(title, body) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">`
    + `<h2 style="margin:0 0 12px">${title}</h2><div>${String(body).replace(/\n/g, '<br/>')}</div></div>`;
}

// PUSH channel: a real Expo send (mirrors notifications.js transport)
async function expoPush(appUserId, announcement) {
  const { rows } = await clientlessQuery(
    'SELECT expo_push_token FROM push_tokens WHERE user_id = $1', [appUserId]
  );
  const tokens = rows.map((r) => r.expo_push_token);
  if (!tokens.length) return { kind: 'skip', detail: 'no_push_token' };
  for (const token of tokens) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: token, title: announcement.title, body: announcement.body, sound: 'default',
          data: { type: 'gym_announcement', announcement_id: announcement.id, gym_id: announcement.gym_id },
        }),
      });
      if (!res.ok) return { kind: 'fail', detail: `expo_http_${res.status}` };
    } catch (err) {
      return { kind: 'fail', detail: `expo_error: ${String(err.message).slice(0, 120)}` };
    }
  }
  return { kind: 'sent' };
}

// small helper so expoPush works with either a client or the pool
function clientlessQuery(text, params) {
  return query(text, params);
}

// ── fan-out: resolve + queue + deliver for ONE announcement (inside tx) ────
async function fanOut(client, announcement, actor) {
  const audience = await resolveAudience(client, announcement);
  const smtpOk = smtpConfigured();
  const summary = { audience: audience.length, sent: 0, skipped: 0, failed: 0 };

  for (const member of audience) {
    // INACTIVE at send: a listed member who left before the announcement
    // went out. Broad audiences never resolve CANCELLED members (filtered
    // in SQL); SPECIFIC_MEMBERS keeps them so the ledger shows WHY nothing
    // was delivered. Channel picked like any other member would get.
    if (member.status === 'CANCELLED') {
      const channel = member.app_user_id != null ? 'IN_APP' : 'EMAIL';
      const d = await claimDelivery(client, announcement, member.id, channel);
      if (d) {
        await markDelivery(client, d.id, 'SKIPPED', 'member_inactive_at_send');
        summary.skipped += 1;
      }
      continue;
    }

    const connected = member.app_user_id != null;
    if (connected) {
      // IN_APP: a notifications inbox row (transactional with the ledger)
      const inApp = await claimDelivery(client, announcement, member.id, 'IN_APP');
      if (inApp) {
        const { rowCount } = await client.query(
          `INSERT INTO notifications (recipient_id, actor_id, type, title, body, deep_link_ref)
           SELECT $1, $2, 'gym_announcement', $3, $4, $5
           WHERE NOT EXISTS (
             SELECT 1 FROM notifications
             WHERE recipient_id = $1 AND type = 'gym_announcement'
               AND title = $3 AND body = $4
           )`,
          [member.app_user_id, actor?.userId ?? null, announcement.title, announcement.body,
           `gym-announcement:${announcement.id}`]
        );
        if (rowCount === 0) {
          // inbox row already exists from a crashed tick — still finish the ledger
          await markDelivery(client, inApp.id, 'SENT', 'in_app (recovered)');
        } else {
          await markDelivery(client, inApp.id, 'SENT', 'in_app');
        }
        summary.sent += 1;
      }

      // PUSH: only with a registered Expo token — never faked
      const push = await claimDelivery(client, announcement, member.id, 'PUSH');
      if (push) {
        try {
          const result = await expoPush(member.app_user_id, announcement);
          if (result.kind === 'sent') { await markDelivery(client, push.id, 'SENT', 'expo_push'); summary.sent += 1; }
          else if (result.kind === 'skip') { await markDelivery(client, push.id, 'SKIPPED', result.detail); summary.skipped += 1; }
          else { await markDelivery(client, push.id, 'FAILED', result.detail); summary.failed += 1; }
        } catch (err) {
          await markDelivery(client, push.id, 'FAILED', `push_error: ${String(err.message).slice(0, 120)}`);
          summary.failed += 1;
        }
      }
    } else {
      // EMAIL: non-app members only
      const email = await claimDelivery(client, announcement, member.id, 'EMAIL');
      if (email) {
        if (!member.email) {
          await markDelivery(client, email.id, 'SKIPPED', 'no_email_address');
          summary.skipped += 1;
        } else if (!smtpOk) {
          await markDelivery(client, email.id, 'SKIPPED', 'email_not_configured');
          summary.skipped += 1;
        } else {
          try {
            await smtpProvider.send({
              to: member.email,
              subject: announcement.title,
              text: announcement.body,
              html: emailHtml(announcement.title, announcement.body),
            });
            await markDelivery(client, email.id, 'SENT', `email:${member.email}`);
            summary.sent += 1;
          } catch (err) {
            await markDelivery(client, email.id, 'FAILED', `smtp_error: ${String(err.message).slice(0, 120)}`);
            summary.failed += 1;
          }
        }
      }
    }
  }
  return summary;
}

// ── publish now (DRAFT → SENT) ─────────────────────────────────────────────
async function publishAnnouncement(gymId, id, actor, ip, gymAudit) {
  return transaction(async (client) => {
    const tz = await gymTz(client, gymId);
    const before = await loadAnnouncement(client, gymId, id);
    if (before.status === 'SENT') throw new HttpError(409, 'This announcement was already sent');
    if (before.status === 'CANCELLED') throw new HttpError(409, 'Cancelled announcements cannot be sent');
    if (before.status === 'SCHEDULED') {
      throw new HttpError(409, 'This announcement is scheduled — it dispatches automatically at its due time (cancel it first to change course)');
    }
    const { rows } = await client.query(
      `UPDATE gym_announcements SET status='SENT', published_at=now(), updated_at=now()
       WHERE id=$1 AND gym_id=$2 RETURNING *`,
      [id, gymId]
    );
    await gymAudit(client, {
      gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? null, ip,
      action: 'announcement.published', entity: 'gym_announcement', entityId: id,
      after: { mode: 'immediate', title: before.title },
    });
    const summary = await fanOut(client, rows[0], actor);
    return { ...withLocal(rows[0], tz), delivery_summary: summary };
  });
}

// ── dispatcher: promote due SCHEDULED rows + finish stranded sends ─────────
// Idempotent and safe to tick as often as desired (also the cron hook):
//   1. SCHEDULED with scheduled_for <= now() → SENT + audience fan-out
//   2. any SENT announcement of this gym with QUEUED rows (a crashed tick)
//      → just re-process the queue; the dedupe key prevents double sends
async function dispatchDue(gymId, actor, ip, gymAudit) {
  const promoted = [];
  const rescued = [];
  return transaction(async (client) => {
    const tz = await gymTz(client, gymId);
    const { rows: due } = await client.query(
      `SELECT * FROM gym_announcements
       WHERE gym_id=$1 AND status='SCHEDULED' AND scheduled_for <= now()
       ORDER BY scheduled_for
       FOR UPDATE SKIP LOCKED`,
      [gymId]
    );
    for (const a of due) {
      const { rows } = await client.query(
        `UPDATE gym_announcements SET status='SENT', published_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`, [a.id]
      );
      promoted.push(a.id);
      await gymAudit(client, {
        gymId, actorUserId: actor?.userId ?? null, actorLabel: actor?.label ?? 'system:dispatch', ip,
        action: 'announcement.published', entity: 'gym_announcement', entityId: a.id,
        after: { mode: 'scheduled_dispatch', title: a.title },
      });
      await fanOut(client, rows[0], actor);
    }

    // stranded QUEUED rows on already-SENT announcements (crash recovery).
    // FOR UPDATE cannot ride on GROUP BY/DISTINCT — collect ids first, then
    // lock each announcement row and re-check it is still SENT.
    const { rows: strandedIds } = await client.query(
      `SELECT DISTINCT a.id FROM gym_announcements a
       JOIN gym_announcement_deliveries d ON d.announcement_id = a.id AND d.status='QUEUED'
       WHERE a.gym_id=$1 AND a.status='SENT'`,
      [gymId]
    );
    for (const { id } of strandedIds) {
      const { rows: locked } = await client.query(
        'SELECT * FROM gym_announcements WHERE id = $1 AND gym_id = $2 FOR UPDATE SKIP LOCKED',
        [id, gymId]
      );
      if (!locked.length || locked[0].status !== 'SENT') continue;
      rescued.push(id);
      await fanOut(client, locked[0], actor); // claimDelivery re-queues only QUEUED rows
    }
    return { dispatched: promoted.length, rescued: rescued.length,
             announcement_ids: [...promoted, ...rescued] };
  });
}

// ── staff reads ────────────────────────────────────────────────────────────
async function listAnnouncements(gymId, { status, q } = {}) {
  const vals = [gymId];
  const where = ['a.gym_id = $1'];
  if (status) { vals.push(String(status).toUpperCase()); where.push(`a.status = $${vals.length}`); }
  if (q) {
    vals.push(`%${String(q)}%`);
    where.push(`(a.title ILIKE $${vals.length} OR a.body ILIKE $${vals.length})`);
  }
  const { rows } = await query(
    `SELECT a.*,
            u.name AS created_by_name,
            (SELECT COUNT(*)::int FROM gym_announcement_deliveries d
              WHERE d.announcement_id = a.id AND d.status='SENT')    AS sent_count,
            (SELECT COUNT(*)::int FROM gym_announcement_deliveries d
              WHERE d.announcement_id = a.id AND d.status='SKIPPED') AS skipped_count,
            (SELECT COUNT(*)::int FROM gym_announcement_deliveries d
              WHERE d.announcement_id = a.id AND d.status='FAILED')  AS failed_count,
            (SELECT COUNT(*)::int FROM gym_announcement_deliveries d
              WHERE d.announcement_id = a.id AND d.status='QUEUED')  AS queued_count,
            (SELECT COUNT(*)::int FROM gym_members gm
              WHERE gm.gym_id = a.gym_id AND gm.${ACTIVE_SQL}
                AND ( (a.audience_type='ALL_ACTIVE_MEMBERS')
                   OR (a.audience_type='SPECIFIC_BRANCH' AND gm.branch = a.audience_branch)
                   OR (a.audience_type='SPECIFIC_MEMBERS'
                       AND gm.id = ANY(ARRAY(SELECT jsonb_array_elements_text(a.audience_member_ids))::uuid[]))
                )) AS current_audience_size
     FROM gym_announcements a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC`,
    vals
  );
  return rows;
}

async function getAnnouncement(gymId, id) {
  const { rows } = await query(
    `SELECT a.*, u.name AS created_by_name
     FROM gym_announcements a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.id=$1 AND a.gym_id=$2`,
    [id, gymId]
  );
  if (!rows.length) throw new HttpError(404, 'Announcement not found');
  const ann = rows[0];
  const { rows: deliveries } = await query(
    `SELECT d.*, gm.first_name, gm.last_name, gm.member_code, gm.app_user_id, gm.email
     FROM gym_announcement_deliveries d
     JOIN gym_members gm ON gm.id = d.member_id
     WHERE d.announcement_id = $1
     ORDER BY d.created_at, gm.member_code`,
    [id]
  );
  const summary = { sent: 0, skipped: 0, failed: 0, queued: 0 };
  for (const d of deliveries) {
    const key = d.status.toLowerCase();
    if (summary[key] !== undefined) summary[key] += 1;
  }
  return { ...ann, deliveries, delivery_summary: summary };
}

// ── member-facing (mobile): SENT announcements of the caller's gyms ────────
async function listForMember(appUserId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT a.id, a.gym_id, g.name AS gym_name, a.title, a.body,
            a.audience_type, a.published_at,
            d.channel, d.status AS delivery_status, d.sent_at, d.detail
     FROM gym_announcement_deliveries d
     JOIN gym_announcements a ON a.id = d.announcement_id AND a.status = 'SENT'
     JOIN gyms g ON g.id = a.gym_id
     JOIN gym_members gm ON gm.id = d.member_id
     WHERE gm.gym_id = ANY(
             SELECT gym_id FROM gym_members
             WHERE app_user_id = $1 AND ${ACTIVE_SQL})
       AND gm.app_user_id = $1
     ORDER BY a.published_at DESC
     LIMIT $2 OFFSET $3`,
    [appUserId, limit, offset]
  );
  // collapse to one row per announcement, keeping the richest channel status
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) {
      byId.set(r.id, { ...r, channels: [r.delivery_status] });
    } else {
      byId.get(r.id).channels.push(r.delivery_status);
    }
  }
  return [...byId.values()];
}

module.exports = {
  AUDIENCE_TYPES, wallToInstant, instantToWall,
  createAnnouncement, updateAnnouncement, cancelAnnouncement, publishAnnouncement,
  dispatchDue, listAnnouncements, getAnnouncement, listForMember,
};
