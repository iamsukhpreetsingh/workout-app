-- 055: Scheduled-renewal management (Phase 13).
--
-- The UPCOMING membership (scheduled successor term) becomes fully
-- manageable: edit renewal (plan/dates/notes), cancel renewal — with the
-- price LOCKED WHEN SCHEDULED (the stored price_cents snapshot only
-- changes when the admin explicitly edits the renewal; plan price changes
-- never touch it) and a distinct lifecycle event trail.
--
-- `notes` rides on the term row (free text the admin attaches to the
-- scheduled commitment, e.g. "Start with 3 sessions/week.").

ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS notes TEXT;
