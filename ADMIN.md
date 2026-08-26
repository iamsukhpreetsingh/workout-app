
════════════════════════════════════════════════════════════════════
WORKOUT TRACKER — ADMIN DASHBOARD: FULL SPECIFICATION
════════════════════════════════════════════════════════════════════

You are building a full-featured, web-based Admin Dashboard for the Workout Tracker platform
(mobile app + Express/Postgres backend already built per prior specs). This is a SEPARATE web
application — not part of the mobile app — used internally by your team to manage users,
trainers, content, and platform health. The defining requirement: it must be EXTENSIBLE BY
DEFAULT — when a new database table or backend API endpoint is added to the platform in the
future, it should appear in the admin dashboard automatically, without anyone having to write
new dashboard UI code for it. This is achieved through two auto-discovery mechanisms (Phases 2
and 3), not by hand-building a screen per feature.

Work through phases in order — later ones depend on earlier ones.

════════════════════════════════════════
STACK & ARCHITECTURE
════════════════════════════════════════

- Frontend: React + TypeScript, one consistent component/table library for data-dense admin UIs
  (Mantine, Ant Design, or shadcn/ui + TanStack Table — pick one, never mix).
- Backend: a thin admin-API layer (/admin/*) on top of the EXISTING Express/Postgres backend —
  reuse the existing pg pool and data-access patterns, not a separate service.
- Admin authentication is SEPARATE from the mobile app's user/trainer auth — a distinct
  admin_users table and login flow, never reusing the app's users table or JWTs.
- Deploy as its own web app, ideally on its own subdomain (admin.yourapp.com), no public signup.

════════════════════════════════════════
PHASE 1 — Admin authentication and role-based access control
════════════════════════════════════════
Schema (new migration):
admin_users: id (UUID pk), email (unique, not null), password_hash (bcrypt, not null), name,
role (CHECK IN ('super_admin','support','content_moderator','analyst','read_only')),
is_active (default true), created_at, last_login_at (nullable).
admin_sessions or a JWT + short-lived-refresh-token pattern (consistent with the mobile app's
own auth design) — pick one.

Role capabilities (enforced server-side via middleware on every /admin/* route, never just
hidden in the UI):

- super_admin: full access, including managing other admin_users.
- support: user/trainer lookup, impersonation (Phase 13), password-reset/unlock actions, broad
  read access, no destructive bulk actions, no config/flag changes.
- content_moderator: read/write on recipes, workout templates, tag vocabularies, reported
  content — no PII beyond moderation context, no billing/analytics.
- analyst: read-only on Analytics (Phase 12) and the generic browser (Phase 2), no writes.
- read_only: read everywhere, write nowhere — safe default for new hires/auditors.

Endpoints: POST /admin/auth/login, /admin/auth/refresh, /admin/auth/logout (mirrors the mobile
app's access/refresh pattern). Middleware: requireAdminRole(...allowedRoles). GET /admin/me
returns the caller's own role/permissions (UI convenience only, never the actual enforcement).

Acceptance criteria:

- Every /admin/* endpoint rejects a role not permitted for that action (verify at least one
  boundary per role, e.g. 'analyst' attempting any write → 403).
- Admin login is fully independent of the mobile app's login in both directions.

════════════════════════════════════════
PHASE 2 — Generic entity browser (auto-discovers new DATABASE TABLES)
════════════════════════════════════════
Backend:

- GET /admin/schema — introspects information_schema.columns and table_constraints for every
  table in the public schema; returns columns, types, nullability, primary keys, and foreign-key
  relationships, generated live — reflects any new migration on its very next call, zero code
  changes required.
- GET /admin/data/:table?page=&pageSize=&sort=&filter= — generic paginated read, table name
  validated against the live schema before querying (never interpolate an unvalidated name into
  SQL). Supports column-based sort/filter validated against that table's real columns.
- GET /admin/data/:table/:id — single-row fetch by primary key.
- PATCH /admin/data/:table/:id, DELETE /admin/data/:table/:id — generic write/delete,
  super_admin-only by default for any table not explicitly configured otherwise.
- Exclusion/override config (one file or table, e.g. admin_table_config.json): tables that must
  NEVER expose write access or sensitive columns (password_hash, refresh tokens, push tokens —
  masked or excluded, full stop), tables that have a custom dedicated module instead (still
  readable here for debugging, but navigation routes to the custom module by default), and
  per-table minimum-role overrides. This file is the ONE place a human touches when a table needs
  special handling — everything else just works automatically with sane defaults (read at
  'support'+, write at 'super_admin').

Frontend:

- A "Database" nav section calling GET /admin/schema on load, rendering every table dynamically
  (light grouping by name prefix is fine) — clicking one opens a generic sortable/filterable/
  paginated data grid with zero table-specific frontend code.
- Row detail/edit: a form generated from the column list (text/number/checkbox/FK-dropdown/date-
  picker as appropriate; sensitive columns render read-only/masked; primary keys always
  read-only).
- MUST correctly render a brand-new table added after this dashboard is built, with zero
  frontend changes — this is the literal test of "automatic."

Acceptance criteria:

- A new table via a plain SQL migration is browsable/editable in Database on next page load,
  respecting default role restrictions.
- Sensitive columns are never returned by GET /admin/data/:table for any table — verify against
  admin_users and users directly.
- A crafted/invalid table name in the URL is rejected before any query is built.

════════════════════════════════════════
PHASE 3 — API endpoint registry & explorer (auto-discovers new API ENDPOINTS)
════════════════════════════════════════
Backend: a lightweight route-registration wrapper used for every route across the ENTIRE
backend (mobile API and admin API alike) going forward:


registerRoute({

method: 'POST',

path: '/trainer/clients/:clientId/assigned-plans',

description: 'Trainer creates and assigns a new workout plan to a specific client',

requiresAuth: true,

allowedRoles: ['trainer'],

category: 'Workouts',

}, handler)



This both registers the route with Express normally AND pushes its metadata into an in-memory
(or DB-backed) registry populated at server startup. Refactor existing routes to this wrapper
incrementally — it does not need to happen all at once — but every NEW route from this point
forward MUST use it; treat this as a required convention, documented clearly in the backend
README, ideally with a startup check/lint rule warning if a raw app.post/get/patch/delete call
bypasses the wrapper.

Endpoint: GET /admin/api-registry — returns every registered route's metadata (method, path,
description, required auth/roles, category), read live from the registry.

Frontend: an "API Explorer" section listing every registered endpoint grouped by category — a
live, always-current internal API reference generated from the code itself, never a hand-
maintained doc that goes stale. For GET endpoints only, a "Try it" panel (parameter inputs
generated from :path params, plus a query-string builder) executes the call using the admin's
own session and shows the raw JSON response. Do NOT provide a "Try it" executor for mutating
(POST/PATCH/DELETE) endpoints — documentation-only for those, the execution risk isn't worth the
convenience.

Acceptance criteria:

- A newly added endpoint using registerRoute() appears in API Explorer immediately on next
  dashboard load, with zero dashboard code changes.
- "Try it" successfully executes a real GET call and displays the response for at least one
  endpoint per major category.

════════════════════════════════════════
PHASE 4 — User & Trainer management (custom module)
════════════════════════════════════════

- Searchable/filterable account list (name, email, role, active/suspended, signup date, last
  login, and current sync mode — auto/manual/local_only — pulled from the account's local
  preference sync, useful for support diagnosing "why is my data missing" tickets).
- Account detail: profile, role, activity summary (user: session count, last workout date;
  trainer: client count, active vs. archived breakdown), and sync health for that specific
  account (last successful sync, pending/failed queue count — sourced from Phase 11).
- Actions: suspend/reactivate (is_suspended column, checked at login), force-logout (revoke
  refresh tokens), trigger password reset, and — for a trainer — view their full client roster
  with each relationship's status.
- Role change (super_admin only): user↔trainer conversion, blocked/warned if it would orphan a
  trainer's active client relationships.

Acceptance criteria:

- Suspending an account blocks its next mobile login attempt.
- A trainer's client roster view matches real trainer_clients data exactly as that trainer sees
  it in their own app.

════════════════════════════════════════
PHASE 5 — Trainer-client relationship lifecycle (dedicated module)
════════════════════════════════════════
This state machine (pending/active/archived/revoked, plus reactivation) is too complex for the
generic browser to represent usefully.

- A relationship-centric view of every trainer_clients row with full status, archived_at/
  purge_at countdown, and restore_preference/final_decision history for any reactivation.
- Filters: all pending requests platform-wide; archived relationships with purge_at within the
  next 7 days (early warning before permanent deletion); reactivation requests awaiting a
  trainer's response.
- Manual override actions (super_admin only, mandatory audit-log reasoning): force-extend a
  purge_at date, manually force-revoke early, or manually restore an archived relationship if
  the normal flow broke.
- Purge job visibility: a log of every purge_job_runs execution (timestamp, rows purged per
  entity type, errors) and a manual "Run purge job now" trigger, invoking the exact same job
  logic as the cron — never a divergent code path.

Acceptance criteria:

- The 7-day purge warning filter correctly surfaces relationships approaching deletion.
- Manual purge trigger produces identical results to the scheduled cron run.

════════════════════════════════════════
PHASE 6 — Workout content (exercises, routines, templates, assignments)
════════════════════════════════════════

- Global exercise library management: the ~38+ seeded exercises (edit name/muscle group/
  instructions/thumbnail) plus a platform-wide view of ALL user-created custom exercises
  (surfaces duplicate/junk entries worth promoting into the official library).
- Workout Template browser (all trainers): search/filter by trainer/tag/exercise count, and
  surface reuse counts via source_template_id (a free "most popular programs" view).
- Assigned Plans browser: any assignment's full exercise breakdown, template lineage, and
  configured alternatives.
- Substitution audit: aggregate original_exercise_name → swapped-to pairs across session data —
  genuine product intelligence ("everyone swaps Bench Press for the same 2 things").
- Superset-group integrity checker: flags any exercise row whose group_id has no valid pairing
  (an orphaned superset half) — a cheap, worthwhile data-integrity diagnostic.

════════════════════════════════════════
PHASE 7 — Nutrition content (Meal Catalog, personal recipes, diet plans, allergens)
════════════════════════════════════════

- Meal Catalog browser (all trainers) and personal recipe catalog browser (client-authored) —
  search/filter by trainer or user, tag, allergen; view/edit/remove for moderation.
- Diet/Supplement Plan browser: full nested day→meal→item structure, configured alternatives,
  and check-in/adherence history.
- ALLERGEN VOCABULARY CONSISTENCY CHECK: compares allergen string values in use across
  meal_catalog_items.allergens and client_intake_profiles.allergens, flagging mismatched
  spelling/casing (e.g., "Nuts" vs "nuts" vs "tree nuts") that would silently break the automatic
  conflict-matching logic — this is exactly the drift the allergen-matching system depends on
  never happening, so an admin tool is the right place to catch it before it causes a real missed
  -warning incident.
- Tag vocabulary management: every distinct tag across templates/routines/catalog/diet plans,
  with merge-duplicates tooling that updates every affected row across every table.

════════════════════════════════════════
PHASE 8 — Client intake profiles (sensitive — extra access controls)
════════════════════════════════════════

- A MORE RESTRICTED module than the rest of this dashboard: viewing a client's health intake
  (allergens, goals, injuries, medical conditions) requires 'support' role or above, and EVERY
  VIEW (not just edit) is audit-logged — read access to health data is itself sensitive enough
  to warrant logging who looked at what and when, beyond the general write-only audit log.
- Read-only by default in this dashboard — give admins a "flag for review" action rather than
  direct edit capability, so an admin can never accidentally corrupt a client's own medical
  disclosure.
- Completion-rate metric: % of clients with an active trainer who've completed their intake
  profile — surfaces an onboarding gap if trainers are connecting with clients who never finish
  it.

════════════════════════════════════════
PHASE 9 — Progression engine oversight
════════════════════════════════════════

- A live view of every registered progression formula, pulled from the shared formulas.json
  config (same auto-discovery spirit as Phase 3 — a new mobile formula appears here once its
  metadata is added to that shared file).
- Formula usage breakdown platform-wide (product signal — an unused formula may be poorly
  explained in-app).
- Per-client override browser (trainer_client_progression_overrides), filterable by trainer,
  with the ability to clear a stuck/incorrect override for support investigations.

════════════════════════════════════════
PHASE 10 — Notifications
════════════════════════════════════════

- Delivery log: push send attempts with success/failure status (requires the notification
  system to log outcomes).
- Per-type volume over time (workout_assigned, workout_completed, diet_checkin, etc.) — a sudden
  drop to zero for one type flags a broken trigger fast.
- Broadcast/composer tool: compose and send a platform-wide or segmented notification (all
  users, all trainers, users with no trainer, a pasted list of user IDs), reusing the existing
  notifications table and push-delivery mechanism — this just creates rows in bulk and relies on
  the existing delivery path, no new mechanism. Require a confirmation step showing the computed
  audience SIZE before sending.

Acceptance criteria:

- A test broadcast to a small, specific set of user IDs creates notification rows and triggers
  pushes only for that exact set.

════════════════════════════════════════
PHASE 11 — Sync, backup, and restore health
════════════════════════════════════════
The most operationally important module given how much of this platform is offline-first.

- Global sync_queue dashboard: counts by status/entity_type across ALL users, a sortable list of
  persistently-failing items with last_error, filterable — your earliest warning for a systemic
  bug before it becomes a wave of tickets.
- Restore-flow monitoring: count of restores triggered, average duration per entity-type step,
  and any restore failures with the specific failed step — visibility into the exact system that
  fixes the reinstall/data-loss bug, since it's the one most likely to have a subtle failure that
  only shows up in aggregate.
- Storage usage: total progress-photo storage consumed via the storageService abstraction's
  metadata — useful once this moves off local disk to real object storage.
- Manual trigger buttons (super_admin only): "Run purge job now," "Retry all failed sync items
  platform-wide," "Force-recompute a user's PR backfill."

Acceptance criteria:

- Sync failure list and restore-monitoring figures accurately reflect real data, refreshed on
  demand.
- Manual triggers invoke the exact same job logic as their scheduled counterparts.

════════════════════════════════════════
PHASE 12 — Platform analytics
════════════════════════════════════════

- Landing-screen vitals: total users/trainers, active trainer-client relationships, DAU/WAU/MAU,
  workouts logged today/this week, signups over time, a signup→intake-profile→first-workout
  conversion funnel.
- Retention cohort table (signup-week cohorts, % still logging N weeks later).
- Coaching-specific metrics: average clients per trainer, trainer utilization (active vs.
  archived ratio), average time-to-first-assignment, platform-wide diet/supplement adherence
  rate.
- Content health: most- and least-used workout templates/recipes via reuse counts already
  available from the snapshot design.
- Feature adoption: % on a custom progression formula vs. default, % of workouts using exercise
  substitution, % of diet followers who've ever used a swap — tells you which built features are
  actually landing versus going unused.
- All charts via a standard web charting library (e.g., recharts) — do not hand-roll SVG charts
  the way the mobile app does; that constraint doesn't apply here.

Acceptance criteria:

- Every metric is computed via real SQL aggregation, verifiable against a manual query of the
  same data.

════════════════════════════════════════
PHASE 13 — Support tools: impersonation & audit log
════════════════════════════════════════

- Impersonation (support role+): from a user's detail view, "View as this user" generates a
  short-lived, clearly-scoped READ-ONLY token — never allows a write action to succeed while
  impersonating — with a persistent "You are viewing as [User]" banner. This is a structured
  read-only data view, not a full mobile-app-in-browser clone.
- Audit log: EVERY write/delete made anywhere in this dashboard, by any role, is logged
  (admin_user_id, action, target_table, target_id, before/after values where practical,
  timestamp), reviewable in a dedicated, searchable, super_admin-only screen — non-negotiable
  given the volume of sensitive user/health data this platform holds.

Acceptance criteria:

- Every write anywhere in the dashboard (generic edits, suspensions, content removal, flag
  toggles, broadcasts) produces a corresponding audit log entry.
- An attempted write while impersonating is blocked, verified directly.

════════════════════════════════════════
GENERAL REQUIREMENTS
════════════════════════════════════════

- Every /admin/* endpoint requires admin auth and the Phase 1 role-guard middleware, no
  exceptions — including the generic Phase 2/3 endpoints.
- Phases 2 and 3's auto-discovery mechanisms are the core deliverable of this entire project —
  prioritize getting these genuinely correct and low-maintenance over polishing any individual
  custom module (Phases 4-13), since they're what fulfills the "appears automatically"
  requirement. Every custom module in Phases 4-13 is a richer PRESENTATION layered on data the
  generic browser already exposes, not new backend query capability — when a genuinely new
  feature is added to the platform later, the correct default is that it appears automatically
  in Database/API Explorer with zero work, and a custom module only gets built for it if
  support/ops staff genuinely need something richer than a flat table view (nested structures,
  lifecycle state machines, sensitive-data access rules, or computed aggregates).
- Document clearly for future backend developers: "add a table → it appears automatically in
  Database; add an entry to admin_table_config.json only for special handling. Add an endpoint →
  always use registerRoute() so it appears in API Explorer automatically."
- Add a documented test (automated or manual) verifying auto-discovery specifically: add a
  throwaway test table via migration, confirm it appears in Database; add a throwaway test route
  via registerRoute(), confirm it appears in API Explorer; remove both afterward.
