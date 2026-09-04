-- 055: Gym communication & announcements (Phase 14).
--
-- A gym can only ever talk to ITS OWN members: every row is gym-scoped and
-- audience resolution happens at SEND TIME against current membership status.
--
-- ANNOUNCEMENTS (gym_announcements)
--   title / body        the message ("Gym Closure" / "The gym will be closed…")
--   audience_type       ALL_ACTIVE_MEMBERS | SPECIFIC_MEMBERS | SPECIFIC_BRANCH
--   audience_member_ids JSONB array of gym_members.id (SPECIFIC_MEMBERS only)
--   audience_branch     free-form branch label (SPECIFIC_BRANCH only)
--   status              DRAFT → SCHEDULED → SENT; CANCELLED from DRAFT/SCHEDULED.
--                       SENT is terminal — re-publishing is a 409 and the
--                       per-recipient dedupe key below makes double delivery
--                       impossible even under races.
--   scheduled_for       ABSOLUTE instant (timestamptz). The API accepts a
--                       GYM-LOCAL wall time ("YYYY-MM-DD HH:mm") and converts
--                       with the gym's timezone — a New Delhi gym schedules
--                       in IST no matter where the server runs. Due dispatch
--                       is a plain comparison against now(); no cron math.
--
-- DELIVERIES (gym_announcement_deliveries) — one row per (announcement,
-- member, channel), the honest ledger of what actually happened:
--   IN_APP  app-connected members: a row in the existing `notifications`
--           table (type 'gym_announcement') — visible in the app inbox even
--           with no push token.
--   PUSH    app-connected members WITH a registered Expo token: a real
--           Expo push send. No token → SKIPPED 'no_push_token' (never faked).
--   EMAIL   non-app members ONLY (the app channel is push/in-app): attempted
--           when the member has an email address AND SMTP is configured.
--           No email → SKIPPED 'no_email_address'; SMTP not configured →
--           SKIPPED 'email_not_configured'; transport error → FAILED.
--   Members that go CANCELLED between queueing and sending are SKIPPED
--   'member_inactive_at_send' — a member who left never receives anything.
--
-- DEDUPE: dedupe_key = announcement:member:channel UNIQUE — the dispatcher
-- inserts with ON CONFLICT DO NOTHING and retries only QUEUED rows, so a
-- crash or double tick can never notify the same person twice.
--
-- BRANCH: gym_members gains a free-form `branch` label. There is no branch
-- entity in this codebase — SPECIFIC_BRANCH targets members whose label
-- matches, managed on the member record itself.
--
-- MEMBER-FACING: app-connected members also get the announcement in their
-- existing notifications inbox (zero mobile changes required); the mobile
-- side can additionally pull GET /gym/my/announcements later.

-- the existing notifications inbox gains the announcement type
-- IF EXISTS: a drifted database may hold this CHECK under a different
-- (auto-generated) name — don't fail the whole migration for it
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'workout_assigned',
  'diet_assigned',
  'supplement_assigned',
  'workout_completed',
  'diet_checkin',
  'supplement_checkin',
  'admin_broadcast',
  'sync_retry_nudge',
  'gym_announcement'
));

-- branch label for SPECIFIC_BRANCH audiences (free-form, gym-managed)
ALTER TABLE gym_members ADD COLUMN IF NOT EXISTS branch TEXT;

CREATE TABLE IF NOT EXISTS gym_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  audience_type TEXT NOT NULL CHECK (audience_type IN ('ALL_ACTIVE_MEMBERS', 'SPECIFIC_MEMBERS', 'SPECIFIC_BRANCH')),
  audience_member_ids JSONB,
  audience_branch TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')),
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (audience_type != 'SPECIFIC_MEMBERS'
         OR (audience_member_ids IS NOT NULL
             AND jsonb_typeof(audience_member_ids) = 'array'
             AND jsonb_array_length(audience_member_ids) > 0)),
  CHECK (audience_type != 'SPECIFIC_BRANCH'
         OR (audience_branch IS NOT NULL AND length(btrim(audience_branch)) > 0)),
  CHECK (status != 'SCHEDULED' OR scheduled_for IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_gym_announcements_gym
  ON gym_announcements (gym_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_announcements_due
  ON gym_announcements (scheduled_for)
  WHERE status = 'SCHEDULED';

CREATE TABLE IF NOT EXISTS gym_announcement_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  announcement_id UUID NOT NULL REFERENCES gym_announcements(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
  detail TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_ann_deliveries_gym
  ON gym_announcement_deliveries (gym_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_ann_deliveries_announcement
  ON gym_announcement_deliveries (announcement_id);
CREATE INDEX IF NOT EXISTS idx_gym_ann_deliveries_member
  ON gym_announcement_deliveries (member_id, created_at DESC);
-- the dispatcher's work queue: only rows still owed a send
CREATE INDEX IF NOT EXISTS idx_gym_ann_deliveries_queued
  ON gym_announcement_deliveries (created_at)
  WHERE status = 'QUEUED';
