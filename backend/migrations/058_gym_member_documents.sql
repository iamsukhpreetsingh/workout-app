-- 058: Gym documents & digital waivers (Phase 18).
--
-- ARCHITECTURE: a gym_member_document belongs to a GymMember — NEVER
-- directly to a User. A member does not need an app account to have
-- paperwork (app_user_id NULL is the normal case at the front desk), and
-- when the member later connects to the app the existing documents stay
-- exactly where they are: keyed by member id, they simply become visible
-- through the member's own /my endpoints.
--
-- DOCUMENT (gym_member_documents)
--   category  WAIVER | MEMBERSHIP_AGREEMENT | ID_VERIFICATION |
--             MEDICAL_CLEARANCE | OTHER
--   status    PENDING    uploaded, not yet signed/acknowledged
--             AUTHORIZED signed (digital signature or desk-recorded)
--             REPLACED   a newer document of the same category superseded
--                        it (replaced_by → the live successor)
--             REVOKED    staff withdrew it (uploaded in error, wrong
--                        member, forged file…)
--   EXPIRY IS COMPUTED, NOT STORED: expires_at passing the clock does not
--   rewrite history — reads expose effective_status = EXPIRED while the
--   stored status stays AUTHORIZED/PENDING (retention + audit stay honest).
--   Signing an expired document is refused: upload a fresh copy.
--
-- ONE LIVE DOCUMENT PER CATEGORY: a partial unique index on
-- (member_id, category) WHERE status IN ('PENDING','AUTHORIZED') makes
-- "upload a new waiver supersedes the old one" a database invariant, not
-- a convention — the same race-proofing approach as the Phase 17 booking
-- indexes. REPLACED/REVOKED rows keep their history and never block.
--
-- STORAGE: bytes live under uploads/gym-documents/<gymId>/<random>.<ext>
-- (or a private S3 object). Storage keys are random UUIDs — no member id,
-- no category, no guessable sequence — and NOTHING is served statically:
-- server.js 403s the whole /uploads/gym-documents subtree. Bytes move
-- exclusively through authorized endpoints that re-check permission and
-- branch scope on every request.
--
-- DOWNLOAD LOG (gym_document_download_log): who pulled a document's
-- bytes, when, from where. Documents are the member's most sensitive
-- data the gym holds (ID scans, medical clearances) — every download,
-- staff or member, is recorded. Lifecycle events (upload/authorize/
-- revoke) go to the regular gym audit log instead.

CREATE TABLE IF NOT EXISTS gym_member_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN
    ('WAIVER', 'MEMBERSHIP_AGREEMENT', 'ID_VERIFICATION', 'MEDICAL_CLEARANCE', 'OTHER')),
  title TEXT CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'AUTHORIZED', 'REPLACED', 'REVOKED')),
  storage_provider TEXT NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local', 's3')),
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  file_sha256 CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ,
  replaced_by UUID NULL REFERENCES gym_member_documents(id) ON DELETE SET NULL,
  uploaded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  uploaded_via TEXT NOT NULL DEFAULT 'DESK' CHECK (uploaded_via IN ('DESK', 'APP')),
  authorized_at TIMESTAMPTZ,
  authorized_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  authorized_signature TEXT CHECK (authorized_signature IS NULL OR length(btrim(authorized_signature)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_member_documents_member
  ON gym_member_documents (gym_id, member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_member_documents_category
  ON gym_member_documents (gym_id, category, status);

-- one live document per category per member; supersedes are explicit
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_member_document_live
  ON gym_member_documents (member_id, category)
  WHERE status IN ('PENDING', 'AUTHORIZED');

CREATE TABLE IF NOT EXISTS gym_document_download_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES gym_member_documents(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('STAFF', 'MEMBER')),
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_document_download_log_doc
  ON gym_document_download_log (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_document_download_log_gym
  ON gym_document_download_log (gym_id, created_at DESC);
