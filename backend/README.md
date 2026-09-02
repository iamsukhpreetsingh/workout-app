# Workout Tracker — Backend

Node/Express + raw `pg` (no ORM) API for the Workout Tracker mobile app:
accounts and roles, trainer–client relationships, assigned workout and diet
plans, the log-first nutrition system (food diary, food database, targets,
monitoring), and the offline-sync backup surface the mobile app pushes to.

Companion docs: [`../README.md`](../README.md) (mobile app),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) (short architecture map).

---

## 1. Stack & Setup

| Concern   | Choice                                                        |
| --------- | ------------------------------------------------------------- |
| Runtime   | Node ≥ 18 (native`fetch` used for Open Food Facts)         |
| Framework | Express 4                                                     |
| Database  | PostgreSQL via`pg` Pool (no ORM)                            |
| Auth      | JWT access (30 m) + refresh (30 d),`bcryptjs` hashing       |
| Email     | `nodemailer` (password reset, optional)                     |
| Files     | Optional S3 (`@aws-sdk/client-s3`) with local-disk fallback |

`.env`:

```
DATABASE_URL=postgres://user:pass@host:5432/workout_tracker
PGSSL=false                 # true for managed providers
JWT_SECRET=long-random-string
PORT=4000
SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM   # password-reset email
ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD   # first admin (never logged)
# optional — S3 file storage (falls back to local uploads/ without it):
S3_BUCKET / S3_REGION / S3_ACCESS_KEY / S3_SECRET_KEY
```

Commands:

```bash
npm run migrate          # apply migrations/*.sql (append-only, numbered)
npm run migrate-diet     # one-time log-first data migration + food seeding (idempotent)
npm run seed-exercises   # exercise catalog seed
npm run seed-foods       # global food database seed (also self-seeds on first search)
npm test                 # node --test (auth, admin, catalog, nutrition, targets, date semantics)
npm run check-routes     # route-registry guard (runs automatically in npm run dev)
npm run dev              # check-routes && node server.js
```

Migrations are **append-only**: never edit an applied file; add
`04X_description.sql`. The DB connection layer (`src/db/pool.js`) registers a
DATE type parser (OID 1082 → raw `YYYY-MM-DD` string) — calendar dates must
never cross the API as timezone-shifted timestamps.

---

## 2. Conventions

- **Routes** live in `src/routes/{auth,client,trainer,backup,notifications, progressPhotos,progression,exerciseCatalog,syncReport,passwordReset,tags}.js`
  and mount under `/auth`, `/client`, `/trainer`, `/user`, `/exercises`, …
  in `server.js`. Every NEW endpoint must use `registerRoute()` (admin API
  Explorer metadata); `npm run check-routes` enforces it.
- **Auth** (`src/middleware/auth.js`): `requireAuth` verifies the Bearer JWT
  into `req.user = { id, role }`; `requireRole('trainer' | ['user','trainer'])`
  guards by role. Client identity ALWAYS comes from the token — never the body.
- **Data modules** (`src/data/*.js`) own SQL per domain. No SQL in routes.
- **Trainer visibility rule**: trainers may only ever read data scoped to
  their own relationships — `assertActiveAssociation` (writes) /
  `assertReadableAssociation` (reads, includes the 30-day archived window)
  plus `trainer_id`/`plan_server_id` filters. Self-authored client content is
  never exposed to trainers.
- **Mirror rule**: `src/data/nutritionCore.js`, `nutritionTargetsCalc.js`,
  and `buildTrendSummary` (in `nutritionDigest.js`) must stay behaviorally
  identical to the mobile copies in `../src/features/diet/domain/` — all are
  covered by test suites asserting the same scenarios.

---

## 3. API Reference

Machine-readable registry: `GET /admin/api-registry`. Auth = `Authorization: Bearer <accessToken>` unless noted.

### 3.1 Auth — `/auth` (routes/auth.js, passwordReset.js)

| Method & Path                 | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| POST`/auth/signup`          | Create account`{name, email, password, role}` → tokens + user |
| POST`/auth/login`           | Email/password →`{user, accessToken, refreshToken}`           |
| POST`/auth/refresh`         | Refresh token → new token pair (rotation)                       |
| POST`/auth/logout`          | Invalidate refresh token                                         |
| PATCH`/auth/profile`        | Update display name (email is the auth identity — read-only)    |
| POST`/auth/change-password` | Authenticated password change; rotates sessions                  |
| POST`/auth/forgot-password` | Email a single-use reset token (rate-limited)                    |
| POST`/auth/reset-password`  | Consume token → set password, revoke sessions                   |

### 3.2 Client — `/client` (routes/client.js; role `user`/`trainer`)

| Method & Path                                                                                                 | Purpose                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET`/client/trainer`                                                                                        | Association state (null / pending / active + trainer info)                                                 |
| GET`/client/trainer-code-preview?code=`                                                                     | Preview an invite code before connecting                                                                   |
| POST`/client/associations/request`                                                                          | Connect to a trainer by invite code (`restore_preference` for reconnections)                             |
| POST`/client/trainer/unlink`                                                                                | Archive the relationship (trainer keeps 30-day read access)                                                |
| GET/POST/PATCH/DELETE`/client/diet-plans…`                                                                 | Self-authored diet plans (legacy server-first path)                                                        |
| GET/POST/PATCH/DELETE`/client/supplement-plans…`                                                           | Supplement plans                                                                                           |
| GET/POST`/client/diet-plans/:planId/checkins`                                                               | Yes/no diet check-ins                                                                                      |
| GET`/client/coach-dishes`                                                                                   | Active trainer's meal catalog (for swaps)                                                                  |
| GET/POST/PATCH/DELETE`/client/my-dishes`                                                                    | Personal dish catalog (server copy)                                                                        |
| GET/PUT`/client/intake-profile`                                                                             | Nutrition & dietary profile (allergens, body, activity, goal, dietary pattern, preferences, avoided foods) |
| GET`/client/nutrition-targets`                                                                              | Active target (versioned; source = automatic/self/trainer_override) + recommendation + drift flag          |
| POST`/client/nutrition-targets/self`                                                                        | Set own targets (opens a new version; mode daily/weekly_average)                                           |
| GET`/client/food-search?q=&barcode=`                                                                        | Three-layer food search + Open Food Facts fall-through/caching                                             |
| GET`/client/food-log?date=`                                                                                 | Diary entries for one date                                                                                 |
| GET`/client/food-log/recent-frequent`                                                                       | Recent + most-frequent foods                                                                               |
| GET/PUT`/client/nutrition-suggestions`                                                                      | Advisory meal-shape suggestions                                                                            |
| GET`/client/nutrition-weekly-digest`                                                                        | Trend digest (logged-days averages, target status, suggestions)                                            |
| GET`/client/notifications`, PATCH `/:id/read`, `/:id/dismiss`, `/mark-all-read`, POST `/push-token` | Notification center                                                                                        |

### 3.3 Offline sync — `/user/backup` (routes/backup.js)

All upserts are keyed `(user_id, local_entity_id)` — last-write-wins,
idempotent under repeated syncs; deletes are idempotent. These are the ONLY
endpoints the mobile sync engine talks to.

| Method & Path                                                                                                                                        | Entity                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST/GET/DELETE`/user/backup/sessions[/:localId]`                                                                                                  | Full-fidelity workout sessions (+exercises+sets)                                                       |
| POST/GET/DELETE`/user/backup/workout-plans[/:localId]`                                                                                             | Workout routines                                                                                       |
| POST/GET/DELETE`/user/backup/custom-exercises[/:localId]`                                                                                          | Custom exercises                                                                                       |
| POST/GET/DELETE`/user/backup/recipes[/:localId]`                                                                                                   | Personal recipes (My Dishes)                                                                           |
| POST/GET/DELETE`/user/backup/diet-plans[/:localId]`                                                                                                | Self-authored diet plans (+days/meals/items/alternatives/**versions**, tracking_mode, tolerance) |
| POST/GET`/user/backup/diet-checkins`                                                                                                               | Yes/no diet check-ins                                                                                  |
| POST/GET/DELETE`/user/backup/diet-swaps[/:itemRef/:date]`                                                                                          | Date-scoped plan-item swaps                                                                            |
| POST/GET/DELETE`/user/backup/food-log-entries[/:localId]`                                                                                          | **Log-first food diary** (user+date scoped; future dates rejected)                               |
| POST/GET/DELETE`/user/backup/custom-dishes[/:localId]`                                                                                             | Custom dishes (+snapshot ingredients)                                                                  |
| POST/GET/DELETE`/user/backup/food-log[/:localId]`                                                                                                  | LEGACY plan-scoped detailed diary (pre-040 data)                                                       |
| POST/GET/DELETE`/user/backup/supplement-plans[/:localId]`, `/user/backup/supplement-checkins`                                                    | Supplement plans/check-ins                                                                             |
| POST/GET/DELETE`/user/backup/measurements`, `/user/backup/personal-records`, `/user/backup/progress-photos`, `/user/backup/custom-exercises` | Body/PR/photo backups                                                                                  |
| GET`/user/backup/summary`                                                                                                                          | Per-entity counts — drives the mobile restore gate                                                    |
| POST`/sync/report`, `/sync/restore-run/*`                                                                                                        | Sync/restore health telemetry                                                                          |

Side effects: syncing completed past days to `food-log-entries` triggers
idempotent missed-target notification evaluation (see 3.5).

### 3.4 Trainer — `/trainer` (routes/trainer.js; role `trainer`)

Relationships:

| Method & Path                                                        | Purpose                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| POST/GET`/trainer/invite-code` (+`/latest`)                      | Generate / fetch the single-use client invite code                  |
| GET`/trainer/associations?status=`, POST `/associations/:id/accept | reject`                                                             |
| GET`/trainer/clients`                                              | Roster (+`trainer_notifications_enabled`, adherence, last active) |
| POST`/trainer/clients/:clientId/unlink`                            | Archive relationship (30-day read window)                           |
| PATCH`/trainer/clients/:clientId/notification-preference`          | Generic per-client notification toggle                              |

Workouts:

| Method & Path                                                                                                            | Purpose                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| GET/POST`/trainer/clients/:clientId/assigned-plans`, GET/PATCH/DELETE `…/:planId`                                   | Assigned workout plans                        |
| POST`/trainer/clients/:clientId/assigned-plans/from-template/:templateId`                                              | Assign from a template                        |
| GET`/trainer/clients/:clientId/session-summaries`, `…/sessions/:id/details`                                         | Read-only workout summaries + per-set details |
| GET`/trainer/clients/:clientId/volume-by-muscle-group`, `…/strength`, `…/measurements`, `…/measurement-types` | Read-only analytics                           |
| POST/GET/PATCH/DELETE`/trainer/workout-templates…`, `/trainer/exercises…`                                          | Template + exercise management                |

Diet & nutrition (all reads require an active/readable association):

| Method & Path                                                          | Purpose                                                                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET/PATCH/DELETE`/trainer/clients/:clientId/diet-plans…`       | Assign/manage diet plans (days→meals→items, allergens, alternatives)                                                                                            |
| GET`…/diet-plans/:planId/checkins`                                  | Check-in history                                                                                                                                                  |
| GET`…/diet-monitoring?days=`                                        | Exception-first monitoring (statuses, metrics, alerts)                                                                                                            |
| GET`/trainer/diet-monitoring/overview`                               | Per-client status for the whole roster                                                                                                                            |
| GET`…/nutrition-day?date=`                                          | One day: Target Hit/Under/Over/Not Logged, macro statuses, grouped read-only food log                                                                             |
| GET `…/nutrition-history?mode=week                                    | month&date=`                                                                                                                                                      |
| GET`…/nutrition-digest?days=`                                       | Trend digest (plain-language, no compliance %)                                                                                                                    |
| GET`…/activity-map?weeks=4..52`                                     | GitHub-style map summaries (per-day diet color + workout sessions, streaks, week/month stats, attention) — two aggregate queries, never raw per-exercise history |
| GET`…/food-diary?from=&to=`                                         | Raw read-only diary browse                                                                                                                                        |
| GET`…/nutrition-targets`                                            | Active target + recommendation + source/drift                                                                                                                     |
| POST`…/nutrition-targets/override`                                  | Trainer override (new version; recommendation retained; optional note)                                                                                            |
| POST`…/nutrition-targets/use-recommendation`                        | Return to the automatic recommendation                                                                                                                            |
| GET/PUT`…/nutrition-suggestions`                                    | Advisory structure suggestions                                                                                                                                    |
| GET`…/diet-food-log?from=&to=`                                      | Raw assigned-plan diary (legacy detailed mode)                                                                                                                    |
| GET/POST`…/diet-notes`, GET `/client/diet-notes` (+`/:id/read`) | One-way notes with read receipts                                                                                                                                  |
| GET/PUT`…/nutrition-notifications`                                  | Per-client missed-target notification toggle (default OFF)                                                                                                        |
| GET/POST/PATCH/DELETE`/trainer/meal-catalog…`, `/trainer/tags…`  | Trainer dish catalog + tag taxonomy                                                                                                                               |
| GET/PUT/DELETE`/trainer/clients/:clientId/progression-*`             | Auto-progression overrides                                                                                                                                        |

### 3.5 Gym Management — `/gym` (multi-tenant; portal: `../gym-web`, design: `../GYM_MANAGEMENT_DESIGN.md`)

Gym-scoped roles (OWNER/ADMIN/TRAINER/FRONT_DESK/MEMBER) live in
`gym_staff`/`gym_members` — never in `users.role`, which only gains
`gym_staff` as a routing hint. Every route runs
`requireAuth → requireGymContext() → requireGymPermission(…)`; gym/role ids
from the client are selectors, never proof (verified against the JWT).

- **Onboarding (Phase 2)**: `POST /gym` creates the gym from the wizard
  payload (name, timezone, currency, contact, address, `operating_hours`
  JSONB — normalized to 7 days, `branding` JSONB — hex colors, website);
  the creator becomes gym-scoped OWNER; duplicate names are allowed
  (unique machine slug); creation is transactional and touches no personal
  fitness data. `GET /gym/mine` lists gyms + status (incl. INACTIVE);
  `GET /gym/:gymId` returns the gym plus `profile_completion`
  (percent + missing checklist).
- **Profile updates**: `PATCH /gym/:gymId` (settings.manage) validates
  timezone/phone/email/website/hours/branding server-side.
- **Logo**: `POST /gym/:gymId/logo` (base64 PNG/JPEG/WEBP ≤2MB, magic-byte
  sniffed, stored S3-or-local, replaced file removed after the new one
  persists), `GET …/logo` (authorized byte stream), `DELETE …/logo`.
- **Lifecycle**: `POST …/deactivate` (owner; gym → INACTIVE, everyone
  locked out), `POST …/reactivate` (owner-only, resolved directly because
  deactivated gyms fail context resolution; SUSPENDED gyms cannot
  self-reactivate), `POST …/leave` (staff leave; the last active OWNER is
  blocked — transfer ownership or deactivate first).
- **Staff / members / audit (Phase 1)**: `GET/POST/PATCH …/staff` (email
  add, re-hire, last-owner protection), `GET/POST …/members`,
  `GET/PATCH …/members/:id`, `POST …/members/:id/link-app|unlink-app`
  (exact-email link, never duplicates), `GET …/audit-log`
  (append-only), `GET …/permissions` (portal route-guard data).
- **Member management (Phase 4)**: members carry profile fields
  (date_of_birth, gender, emergency contact, free-form `profile` JSONB —
  no government IDs or health data) and `GM-`-prefixed member codes.
  Duplicate guard: one non-CANCELLED member per email per gym (the same
  email at a different gym is a different member); missing email/phone are
  fine. TWO INDEPENDENT state axes: membership `status`
  (ACTIVE/PENDING/FROZEN/EXPIRED/CANCELLED) and derived `app_connection`
  (CONNECTED / NOT_CONNECTED / INVITATION_PENDING). Lifecycle routes
  (members.manage): `POST …/cancel` (member leaves → CANCELLED; record,
  history and app link kept; the underlying User is never touched),
  `POST …/reactivate` (→ ACTIVE), `POST …/invite-app` (one-time code shown
  once, stored SHA-256-hashed in `gym_member_invites`; optional fire-and-
  forget SMTP email), `POST …/cancel-invite`; linking consumes the pending
  invite. List filters: `status=` (membership) and `connection=` (app).
- **Invitation bridge (Phase 5)**: the plaintext one-time code IS the
  bearer token (128-bit, shown once, SHA-256-hashed in
  `gym_member_invites` with a 7-day `expires_at`). Public token routes —
  registered BEFORE `/:gymId`: `GET /gym/invite/:token` (landing-page
  preview), `POST …/decline` (→ DECLINED, member back to NOT_CONNECTED),
  `POST …/register` (creates the User AND links the existing GymMember
  atomically; 409 with no partial rows if the email already exists),
  `POST …/accept` (requireAuth; the account email must match the invited
  email EXACTLY — arbitrary linking is impossible). Invitation lifecycle:
  PENDING → ACCEPTED | DECLINED | EXPIRED | CANCELLED; acceptance is
  blocked for suspended/deactivated gyms and cancelled members, and is
  audited (`member.invite_accepted|declined`). `GET /auth/me` exposes the
  signed-in account's safe profile for the portal's identity probe.
- **Membership plans (Phase 6)**: `membership_plans` belong to a gym
  (name unique per gym, duration value+unit day/week/month/year, price in
  integer minor units, currency, access_level, included PT sessions,
  DRAFT/ACTIVE/ARCHIVED). Only ACTIVE plans are assignable; ARCHIVED plans
  block NEW assignments while existing memberships stay valid — every
  `member_memberships` row SNAPSHOTS plan name/price/currency/duration at
  assignment, so plan edits never rewrite history. Routes (plans.manage is
  OWNER; memberships.manage OWNER/ADMIN; memberships.view also FRONT_DESK):
  `GET/POST/PATCH /gym/:gymId/plans`, `GET /gym/:gymId/memberships`
  (gym-wide, search+filter+pagination), `GET/POST
  /gym/:gymId/members/:memberId/memberships` (assign; `replace_active`
  performs a plan change and keeps the old term as CANCELLED history),
  `POST …/memberships/:id/cancel`, `POST …/memberships/:id/renew`
  (early renewal → UPCOMING starting the day after the current term ends,
  snapshotting the plan's CURRENT price; expired-but-uncancelled terms
  renew ACTIVE today). Assignment works identically for members with and
  without app accounts.
- **Membership lifecycle (Phase 7)**: statuses
  ACTIVE/FROZEN/UPCOMING/CANCELLED/EXPIRED. FREEZE RULE (one consistent
  rule everywhere): a freeze pauses the term; on resume (or freeze
  cancel) `ends_on` moves forward by the EXACT number of frozen calendar
  days (the resume day itself is not frozen) — freeze 01 Aug → resume
  01 Sep shifts expiry by 31 days. Frozen terms never auto-expire; a term
  still ending before today after the shift becomes EXPIRED; scheduled
  (UPCOMING) renewals slide by the same days. Renewal is blocked while
  frozen; renewing an expired term starts a new ACTIVE term today; a plan
  change cancels a frozen term and closes its freeze. `membership_freezes`
  (one open freeze per membership) and append-only `membership_events`
  (assigned/frozen/resumed/extended/renewed/cancelled/expired) preserve
  the full lifecycle — never a bare status overwrite. Expiry and
  UPCOMING→ACTIVE promotion are evaluated lazily in the GYM'S TIMEZONE on
  every read (idempotent, no cron). Routes (memberships.manage):
  `POST …/memberships/:id/freeze|resume|extend`; `GET
  …/memberships/events` (memberships.view) returns the timeline. Manual
  extension: `extend {days 1-365}` pushes expiry and slides scheduled
  renewals. `GET /gym/my/memberships` now carries the current plan term
  (plan_name, membership_status, ends_on) for the mobile My Gym card.
- **Staff & trainer management (Phase 8)**: staff roles stay gym-scoped
  (OWNER/ADMIN/TRAINER/FRONT_DESK in `gym_staff`) and are NEVER derived
  from users.role — a platform trainer (`users.role 'trainer'`) is a
  different concept, and the same person can be a TRAINER at several gyms.
  `POST /gym/:gymId/staff` with an email that has NO app account creates a
  STAFF INVITATION (`gym_staff_invites`, one-time hashed code, 7-day
  expiry, one PENDING per email per gym) — the public `/gym/invite/:token`
  preview/accept/decline/register routes dispatch by type; register
  creates the User AND the staff row atomically. Trainer assignments
  (`gym_trainer_assignments`): `GET /:gymId/trainers` (assignable ACTIVE
  TRAINER staff), `POST /:gymId/members/:memberId/trainer` (members.manage;
  reassignment ENDS the previous assignment, history kept),
  `POST …/trainer/:id/end`, `GET …/trainer` (member history),
  `GET /:gymId/trainer-assignments` (gym-wide; a TRAINER is always
  server-filtered to their own row), `GET /:gymId/trainer/members`
  (assigned_members.view → the trainer's roster incl. membership status).
  A trainer with ACTIVE assignments cannot be demoted/deactivated/removed
  until members are reassigned (409). Non-app members (app_user_id NULL)
  are first-class: assignments reference gym_members, never users.
- **Standalone users are unaffected**: zero gyms is a fully supported
  state; membership plans/payments/attendance/classes are NOT implemented yet.

### 3.6 Admin — `/admin` (role-gated; dashboard: `../admin-dashboard`)

- Auth/bootstrap, user & role management, broadcasts, sync-health views,
  API Explorer (`GET /admin/api-registry`).
- **Nutrition module** (`src/admin/nutritionAdmin.js`): meal catalog, global
  foods (`GET/POST /admin/nutrition/global-foods`, POST `…/:id/verify`,
  DELETE `…/:id`), tag vocabulary, allergen consistency, diet-plan detail
  (check-in summaries, recent swaps).
- Food database growth: seeded staples + auto-cached Open Food Facts lookups
  (verified=false) + admin promotion to verified + admin-added entries.

---

## 4. Database Schema (domains; see `migrations/*.sql` for exact columns)

| Domain                | Tables                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts              | `users`, `refresh_tokens`, `password_reset_tokens`, `admin_users`, `push_tokens`, `notifications`                                                                                                                                                                                                                                                                                                                       |
| Relationships         | `trainer_clients` (status lifecycle: pending → active → archived(30-day read) → revoked; `trainer_notifications_enabled`), `trainer_invite_codes`, `client_intake_profiles` (profile + nutrition inputs + allergens; `completed_at` gates warnings)                                                                                                                                                                    |
| Assigned workouts     | `assigned_plans`, `assigned_plan_exercises`(+alternatives), `session_summaries` (aggregate-only), `session_exercise_details`, `trainer_tags`, `trainer_workout_templates`, `exercises` (catalog)                                                                                                                                                                                                                      |
| Assigned diet         | `diet_plans` (+`tracking_mode`, `tolerance_pct`), `diet_plan_days/meals/meal_items`, `diet_plan_meal_item_alternatives`, `meal_catalog_items`, `diet_checkins`, `diet_item_swaps`                                                                                                                                                                                                                                   |
| Log-first nutrition   | `food_log_entries` (user+date scoped; source: global_database/personal_recipe/trainer_recipe/custom_dish/manual), `global_foods` (seed/cached-external/admin; verified flag, barcode, cuisine_tags, usage_count), `custom_dishes` + `custom_dish_ingredients` (snapshot macros), `structure_suggestions` (advisory)                                                                                                       |
| Targets               | `user_nutrition_targets` (versioned; `target_source` automatic/self/trainer_override, `target_mode` daily/weekly_average, `set_by`, `override_note`, `recommended_snapshot`)                                                                                                                                                                                                                                            |
| Monitoring            | `trainer_nutrition_prefs` (per relationship, default OFF), `diet_target_notifications` (idempotency ledger: UNIQUE(trainer, client, date, direction))                                                                                                                                                                                                                                                                           |
| Backups (mobile sync) | `backup_sessions/exercises/sets`, `client_workout_plans`, `backup_custom_exercises`, `user_recipes`, `backup_diet_plans/days/meals/meal_items/**_versions`, `backup_diet_checkins`, `diet_item_swaps`, `backup_food_log_entries` (legacy), `backup_food_log_entries` → `food_log_entries` (log-first), `backup_custom_dishes` → `custom_dishes(+ingredients)` — all `UNIQUE(user_id, local_entity_id)` |
| Misc                  | `measurement_entries`, `backup_personal_records`, `backup_progress_photos` (+S3/local storage), `diet_trainer_notes`, `sync_status_reports`, `restore_runs`                                                                                                                                                                                                                                                             |

Indexes exist for every hot query path (user+date on diaries, plan+date on
swaps/versions, trainer relationship joins). Never drop or rewrite historical
tables — old models are kept read-only.

---

## 5. Domain Rules (centralized — do not re-implement elsewhere)

- **Target status** (`nutritionCore.evaluateAgainstTarget`): inclusive
  tolerance, cross-multiplied integers (2400 ±10% → 2160/2640 inclusive).
  Calories are the headline; macros are independent.
- **not_logged ≠ under_target**; today is never a final failure.
- **Averages exclude not-logged days** (they are never zero-filled).
- **Recommendation** (`nutritionTargetsCalc.calculateRecommendation`):
  Mifflin-St Jeor → activity factor → goal/intensity adjustment (floors
  1200/1500 kcal) → protein g/kg by goal → fat share → carbs remainder.
  Incomplete profile → no recommendation.
- **Target versioning**: every change opens a version (`effective_from` =
  today); profile saves open an automatic version only when the latest
  version is automatic AND inputs changed. Trainer overrides are never
  silently overwritten.
- **Notifications** (`nutritionDigest.evaluateMissedTargetNotifications`):
  completed past days only, gated on the per-relationship preference,
  deduplicated by the `diet_target_notifications` ledger (one per
  trainer+client+date+direction). On-target days never notify — plan
  deviation is not a trigger.
- **Phantom-call rule**: helpers like `assertActiveAssociation` live in
  `assignedPlans.js` — never on `coachingPlans`. A static sweep of all
  `module.fn()` calls is part of review (this exact bug class shipped twice).

---

## 6. Testing & Verification

```bash
npm test                 # 63 tests: auth flows, admin RBAC, catalog, nutrition
                         # core (tolerance boundaries, monitoring), targets
                         # calculator, date semantics, suggestions
node scripts/checkRouteRegistry.js   # every new route uses registerRoute()
node scripts/migrate.js              # apply migrations
node scripts/migrateDietToLogFirst.js # idempotent log-first migration (logs
                                      # before/after row counts; safe to re-run)
```

Live checks against a real database are expected before shipping endpoint
changes — several past bugs (missing helpers, param-count mismatches) were
invisible to module loads and only surfaced on real requests.
