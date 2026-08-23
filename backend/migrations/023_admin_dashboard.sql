-- 023: Admin dashboard support tables. Completely separate from the app's
-- own auth (users table is never reused for dashboard access).

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'support', 'content_moderator', 'analyst', 'read_only')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- rotating refresh tokens, same pattern as the mobile app
CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- every admin write/delete lands here (Phase 10)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID REFERENCES admin_users(id),
  action TEXT NOT NULL,
  target_table TEXT,
  target_id TEXT,
  before_values JSONB,
  after_values JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  rollout_percentage INTEGER CHECK (rollout_percentage IS NULL OR (rollout_percentage BETWEEN 0 AND 100)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Report" action from the mobile app feeds this queue (Phase 5)
CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID REFERENCES users(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('recipe', 'template', 'dish')),
  content_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- purge job run log (Phase 7 — written by scripts/purgeExpiredArchives.js)
CREATE TABLE IF NOT EXISTS purge_job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_purged INTEGER NOT NULL DEFAULT 0,
  relationships_purged INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

-- push delivery outcomes (Phase 7 — best-effort logging from the
-- notification sender; failures never bubble up to the API response)
CREATE TABLE IF NOT EXISTS push_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  token TEXT,
  success BOOLEAN NOT NULL,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- account suspension checked at app login (Phase 4)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;

-- index for the health screen
CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);
CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at DESC);
