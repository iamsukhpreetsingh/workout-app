# Workout Tracker Backend

Express + raw `pg` (no ORM) backend for user accounts, trainer-client
associations, and assigned workout plans. The mobile app remains local-first:
its workout logging data stays in on-device SQLite; this service only handles
accounts/roles/associations and the trainer's assigned-plan model.

## Setup (local Postgres)

1. Install Postgres and create the database:
   ```sh
   createdb workout_tracker
   # or: psql -c "CREATE DATABASE workout_tracker;"
   ```
2. Copy `.env.example` to `.env` and fill in your local password:
   ```
   DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/workout_tracker
   PGSSL=false
   JWT_SECRET=replace-with-a-long-random-string
   ```
3. Install and migrate:
   ```sh
   npm install
   npm run migrate
   ```
4. Start the server:
   ```sh
   npm run dev      # listens on :4000 by default
   ```

Re-running `npm run migrate` is safe — applied migrations are tracked in the
`schema_migrations` table and skipped.

## Cloud provider swap (Supabase / Railway / Neon)

All connection info lives in `DATABASE_URL`, and `PGSSL=true` enables SSL.
Switching providers is a `.env` change only — see the commented example lines
in `.env.example`.

## Layout

- `src/db/pool.js` — the single pg Pool + `query()`/`transaction()` wrappers
- `migrations/` — numbered plain-SQL migrations, applied by `scripts/migrate.js`
- `src/data/` — one data-access module per entity (all raw SQL lives here)
- `src/routes/` + `server.js` — HTTP layer, no inline SQL

## Schema

- `users` (UUID, email, bcrypt password_hash, name, role 'user'|'trainer')
- `refresh_tokens` (server-side revocable refresh tokens)
- `trainer_clients` (trainer↔client association; partial unique index on
  (trainer_id, client_id) WHERE status != 'revoked')
- `trainer_invite_codes` (short codes with expiry)
- `assigned_plans` / `assigned_plan_exercises` (trainer-defined workouts;
  `exercise_name` is plain text — no visibility into client-local SQLite IDs)

Note: workout sessions/sets logged in the mobile app are NOT synced here in
this pass; local SQLite remains the source of truth for training data.

## API

| Method   | Path                                 | Auth    | Notes                                  |
| -------- | ------------------------------------ | ------- | -------------------------------------- |
| POST     | /auth/signup                         | —      | email, password (min 8), name, role    |
| POST     | /auth/login                          | —      | returns user + access + refresh tokens |
| POST     | /auth/refresh                        | —      | rotates both tokens                    |
| POST     | /auth/logout                         | —      | revokes the refresh token              |
| GET      | /me                                  | Bearer  | current profile (never password_hash)  |
| POST     | /trainer/invite-code                 | trainer | 8-char code, 7-day expiry              |
| GET      | /trainer/associations?status=pending | trainer |                                        |
| POST     | /trainer/associations/:id/accept     | trainer | pending → active                      |
| POST     | /trainer/associations/:id/reject     | trainer | → revoked                             |
| GET      | /trainer/clients                     | trainer | active clients                         |
| POST/GET | /trainer/plans[/:id]                 | trainer | requires active association            |
| POST     | /client/request-association          | user    | submits invite code                    |
| GET      | /client/trainer                      | user    | active trainer or null                 |
| GET      | /client/plans                        | user    | plans assigned to me                   |

## Manual test sequence (curl)

```sh
BASE=http://localhost:4000

# 1. signup as a user and as a trainer
curl -s $BASE/auth/signup -H 'Content-Type: application/json' -d \
  '{"email":"client@example.com","password":"password123","name":"Client One","role":"user"}'
curl -s $BASE/auth/signup -H 'Content-Type: application/json' -d \
  '{"email":"trainer@example.com","password":"password123","name":"Coach T","role":"trainer"}'

# 2. login as the trainer (grab accessToken)
TRAINER_TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"trainer@example.com","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

# 3. login as the client
CLIENT_TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"client@example.com","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

# 4. token refresh (use any refresh token from step 2/3)
curl -s $BASE/auth/refresh -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'

# 5. trainer generates an invite code
CODE=$(curl -s $BASE/trainer/invite-code -H "Authorization: Bearer $TRAINER_TOKEN" \
  -X POST | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')

# 6. client requests association with that code
curl -s $BASE/client/request-association -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}"

# 7. trainer sees the pending request and accepts it
ASSOC_ID=$(curl -s "$BASE/trainer/associations?status=pending" \
  -H "Authorization: Bearer $TRAINER_TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
curl -s $BASE/trainer/associations/$ASSOC_ID/accept -H "Authorization: Bearer $TRAINER_TOKEN" -X POST

# 8. trainer creates an assigned plan for the (now active) client
CLIENT_ID=$(curl -s $BASE/me -H "Authorization: Bearer $CLIENT_TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s $BASE/trainer/plans -H "Authorization: Bearer $TRAINER_TOKEN" \
  -H 'Content-Type: application/json' -d "{
    \"clientId\":\"$CLIENT_ID\", \"name\":\"Hypertrophy A\",
    \"exercises\":[{\"exercise_name\":\"Bench Press\",\"target_sets\":4,\"target_reps\":\"8-12\",\"order_index\":0,\"rest_seconds\":90}]
  }"

# 9. NEGATIVE: user-role token on a trainer-only endpoint → expect 403
curl -s $BASE/trainer/invite-code -H "Authorization: Bearer $CLIENT_TOKEN" -X POST
```

## Out of scope (this pass)

Session/photo sync to Postgres, real-time assignment delivery, push
notifications, password reset, email verification, social login, production
deployment.

## Session Summaries (aggregate sync)

`session_summaries` is a deliberately aggregate-only sync target: name, date,
duration, exercise/set counts, and total volume per session. No per-set
detail, RPE, notes, or photos leave the device in this phase.

| Method | Path                                         | Auth     | Notes                                                                         |
| ------ | -------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| POST   | /client/session-summaries                    | any user | batch upsert on (client_id, local_session_id); client_id comes from the token |
| GET    | /trainer/clients/:clientId/session-summaries | trainer  | 403 without an active association;`?limit=20&offset=0`                      |
| GET    | /trainer/clients                             | trainer  | now includes`adherence_pct` + `last_active_at` per client                 |

**Adherence definition** (used everywhere the number is shown): the
percentage of calendar days in the trailing 30 days (server UTC) with at
least one session_summaries row for that client, i.e. distinct workout days
/ 30 × 100, rounded to one decimal. A day with multiple sessions counts once.

### Manual test sequence (session summaries)

Run after the auth-pass test sequence (trainer + client accounts exist and
are associated; `TRAINER_TOKEN` / `CLIENT_TOKEN` / `CLIENT_ID` set):

```sh
BASE=http://localhost:4000

# 1. Batch-sync two summaries (note: no client_id in the body — it comes
#    from the token)
curl -s $BASE/client/session-summaries -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' -d '[
    {"local_session_id":"local-1","name":"Push Day","performed_at":"2026-08-15T17:00:00Z",
     "duration_seconds":3600,"exercise_count":5,"working_set_count":22,"total_volume":9600},
    {"local_session_id":"local-2","name":"Leg Day","performed_at":"2026-08-12T17:00:00Z",
     "duration_seconds":3300,"exercise_count":4,"working_set_count":18,"total_volume":8800}
  ]'

# 2. Re-sync the same local_session_id — row count must stay 1 (update in place)
curl -s $BASE/client/session-summaries -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H 'Content-Type: application/json' -d '[
    {"local_session_id":"local-1","name":"Push Day (edited)","performed_at":"2026-08-15T17:00:00Z",
     "duration_seconds":3700,"exercise_count":5,"working_set_count":22,"total_volume":9700}
  ]'
# verify directly in psql: SELECT count(*) FROM session_summaries WHERE local_session_id='local-1';
# → 1

# 3. Trainer reads their client's summaries (paginated, newest first)
curl -s "$BASE/trainer/clients/$CLIENT_ID/session-summaries?limit=20&offset=0" \
  -H "Authorization: Bearer $TRAINER_TOKEN"

# 4. NEGATIVE: a second, unassociated trainer gets 403
TRAINER2_TOKEN=$(curl -s $BASE/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"trainer2@example.com","password":"password123","name":"Coach Two","role":"trainer"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s $BASE/trainer/clients/$CLIENT_ID/session-summaries \
  -H "Authorization: Bearer $TRAINER2_TOKEN"
# → {"error":"No active association with this client"}

# 5. Adherence + last_active_at on the client list (single aggregate query)
curl -s $BASE/trainer/clients -H "Authorization: Bearer $TRAINER_TOKEN"
# With the two sessions above on distinct days in the trailing 30 days:
#   adherence_pct = 2 / 30 * 100 = 6.7
#   last_active_at = 2026-08-15T17:00:00Z
# Cross-check by hand: count DISTINCT workout days in
#   SELECT (performed_at AT TIME ZONE 'UTC')::date FROM session_summaries;
```

### Invite codes are single-use

Migration 005 adds `trainer_invite_codes.used_at`. A code is valid only while
unexpired AND unused; a successful redemption atomically claims it
(`UPDATE ... WHERE used_at IS NULL RETURNING`), so even two simultaneous
submissions of the same code can't both create associations — the loser gets
409 "This invite code has already been used". Trainers generate a fresh code
any time from the Clients screen.

Test: generate a code, redeem it from client A (201), then try the same code
from client B → 409 "already been used".

## Trainer-client association lifecycle (migrations 015–016)

Status flow on `trainer_clients`: `pending → active → archived → revoked`.

- **Unlink (either party)**: `POST /trainer/clients/:clientId/unlink`
  (trainer) or `POST /client/trainer/unlink` (client) flips an active row to
  `archived` with `archived_at` / `archived_by` / `purge_at = now() + 30 days`.
  All trainer GET endpoints accept `active` OR `archived` (30-day read-only
  window); every create/assign path requires `active`. Client-facing plan
  listings join on `active` only, so the client loses trainer content
  immediately regardless of who initiated.
- **Reactivation**: `GET /client/trainer-code-preview?code=` reports
  `is_reactivation` (an archived row exists for this pair) plus archived date
  and plan counts. `POST /client/associations/request` then REUSES the
  archived row (countdown preserved, data protected) setting
  `status='pending'` and recording the client's `restore_preference`
  ('restore' | 'fresh', migration 016). The duplicate-association guard only
  matches `status IN ('pending','active')` — archived rows must fall through
  to the reactivation branch, never 409.
- **Trainer decision** (`POST /trainer/associations/:id/accept` with
  `final_decision` for reactivations): 'restore' clears the archive fields on
  the same row (history reappears — nothing was deleted); 'fresh' reverts the
  row to archived (untouched countdown) and inserts a separate clean active
  row. `reject` on a reactivation reverts to 'archived'; on an ordinary
  request it revokes.
- **Purge**: `npm run purge-archives` (cron daily `0 3 * * *`) hard-deletes
  trainer-owned content (assigned_plans, trainer-created diet/supplement
  plans + items/checkins) for rows past `purge_at`, then flips them to
  `revoked`. It deliberately **skips rows in 'pending'** — a pending
  reactivation must never be purged while awaiting the trainer's decision,
  even past its original purge_at. Client-owned data (session_summaries,
  exercise details, measurements, self-authored plans) is never touched.

## Development note

`node server.js` does NOT auto-reload. After editing any backend file,
restart the server (or run `npx nodemon server.js`) — a stale process
serving old code has repeatedly masqueraded as bugs (404s on new routes,
stale validation rules).






## Client Intake Profiles

Clients complete a one-time health profile (`client_intake_profiles`, migration `023`):`allergens` and `goals` (TEXT[] chip lists), `injuries` and `medical_conditions` (free text),plus `completed_at`. ONE profile per client, shared across ALL of the client's trainers —the profile belongs to the client, not the trainer-client pair.

**Endpoints**

* `GET /client/intake-profile` — the client's own profile (or `null`)
* `PUT /client/intake-profile` — create/replace; stamps `completed_at` on every save
* `GET /trainer/clients/:clientId/intake-profile` — trainer read (active or archived association)

**Design decision: ONLY allergens are auto-matched.** Allergen tags are the only intakefield ever automatically matched against plan content (diet-plan conflict warnings in theapp). Goals, injuries, and medical conditions are deliberately NEVER auto-matched or usedto generate warnings — "relevant" is a clinical judgment only the trainer can make (adiabetic client can still eat fruit; an injured client can still train upper body). Do notadd medical-condition matching later.

Matching is exact tag intersection (case-insensitive) between the client's allergen tagsand a recipe's snapshotted allergen tags — no synonyms, no ingredient-text inference. If`completed_at` is null (or no profile exists), ALL allergen warnings are skipped silently —no error, no block.

**Privacy:** intake data is sensitive — never in notification bodies, never logged beyondnormal error tracebacks.

## For the root `README.md` — append this section:

## Client Intake Profile (health context)

* **`IntakeFormScreen.js` — one form, two uses:** (1) the onboarding gate — non-dismissible,Android back blocked, shown whenever a client has an active trainer but no completedprofile; saving anything (even all-empty) completes onboarding; (2) Settings → "HealthProfile" — prefilled edit, anytime. Both save to `PUT /client/intake-profile`.
* **`src/lib/allergens.js`** — `getAllergenConflicts(clientAllergens, itemAllergens)`: exact,case-insensitive tag intersection. Allergens are the ONLY auto-matched intake field(rationale in backend README).
* **Trainer-side warnings:** per-row "⚠ Contains: X — client allergy" badge in the dietbuilder's catalog picker; soft "Add anyway?" confirm on attach (never a hard block);persistent red banner on the builder AND the trainer's read-only plan view listing everyconflicting allergen across the whole plan.
* **Client Context** (goals/injuries/medical): collapsible display-only section on thebuilder and plan detail — never generates warnings.
* Gentle one-time prompt (never a gate) when a profiled client connects to a new trainer.

# Manual Test Notes (spec requirement)

Create `docs/manual-test-intake.md` and paste:

# Manual tests — intake profiles & allergen warnings

1. NEW-CLIENT ONBOARDING (gate)Fresh client (no profile) connects via invite code; trainer accepts. Client reopens orforegrounds the app → Health Profile form covers everything; Android back does nothing;no back arrow. Save & Continue (all-empty OK) → closes, never returns. ✅ form appears,non-dismissible, saves.
2. RETURNING CLIENT + SECOND TRAINER (gentle prompt)Profiled client connects to trainer #2 → one-time alert on foreground: Not now / Review."Not now" dismisses; prompt never repeats for THAT trainer (does repeat for a #3).
3. ALLERGEN MATCHING (the required exact case)Client allergens = [nuts, dairy]. Recipe A allergens=[nuts], Recipe B allergens=[gluten].Trainer: Client → Overview → Assign Diet → meal slot → Item:
   * A's row: "⚠ Contains: Nuts — client allergy". Tap → "Add anyway?" dialog.
   * B's row: no warning chip beyond neutral "Contains: gluten". Tap → instant attach.
   * With A in plan: banner "…allergens: Nuts". Add a dairy recipe → banner lists "Nuts, Dairy".
4. NO COMPLETED PROFILE → zero warnings anywhere, zero errors.
5. CLIENT CONTEXT COMBINATIONS: all empty → section hidden; goals-only / injuries-only /medical-only → only that line shows; all filled → three lines; content never warns.
6. READ-ONLY VIEW: Clients → client → Diet → plan → same banner + Client Context.
7. DARK MODE: red warning color legible, banner border visible, chips readable.
8. Trainer's own Recipes tab keeps neutral "Contains:" chips (no client context there).

---

# How to Test the Real Thing

Your app talks to `13.126.205.202:4000`, but our new backend code lives on your machine. **Before testing on your phone:**

1. Copy to the server: your edited `trainer.js` + `client.js`, new `src/data/intakeProfiles.js`, new `migrations/023_client_intake_profiles.sql`
2. On the server, in the backend folder: `node scripts/migrate.js` (expect `applied 023_client_intake_profiles.sql`)
3. Restart the backend process there (however you normally do it — pm2/systemd/`node server.js`)
4. Reload the app and run through test note #1

**One hedge to watch for:** I've never seen `trainerClients.js`, so the gentle-prompt's trainer-ID lookup guesses the response shape of `GET /client/trainer`. If test #2's prompt doesn't appear for an already-profiled client, send me `backend/src/data/trainerClients.js` and I'll give you a one-line fix. Everything else is independent of that.

## Admin dashboard API (`/admin/*`)

A separate admin layer (migration 023) with its own `admin_users` table,
bcrypt passwords, and JWT access + rotating refresh tokens — completely
independent of app auth. Roles (`super_admin`, `support`,
`content_moderator`, `analyst`, `read_only`) are enforced server-side by
`requireAdminRole()` on every route. First server start creates a bootstrap
super admin (`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`, defaults
`admin@workout.local` / `ChangeMe123!`).

Frontend lives in `../admin-dashboard/` (Vite + React + TS + Ant Design).

### Onboarding for backend developers — the extensibility contract

1. **Adding a table?** It appears in the admin Database browser
   AUTOMATICALLY (live `information_schema` introspection). Touch
   `src/admin/tableConfig.js` ONLY if the table needs: exclusion,
   sensitive columns (the global mask already covers `password_hash`,
   token columns), a non-default role, or navigation to a custom module.
   Sensitive columns are masked in every generic response — never returned.
2. **Adding an endpoint?** Use `registerRoute()` from
   `src/admin/registry.js` — NEVER raw `router.get/post/...`. This applies
   to the ENTIRE backend (mobile API and admin API alike). The wrapper
   mounts the route on Express AND records its metadata so it appears in
   the dashboard's API Explorer automatically. Pass the auth/role
   middleware as the 4th argument (single function or array) — it is
   mounted BEFORE your handler; `allowedRoles` is display text for the
   explorer. Run `npm run check-routes` (or `-- --strict` in CI) to flag
   any raw registration that bypasses the wrapper; `npm run dev` prints
   the report on every start.
3. **Every admin write must call `writeAudit()`** — the audit log is the
   platform's accountability guarantee for user/health data. Viewing
   extra-sensitive data (client intake profiles) must call `readAudit()`.

### Admin module layout

Purpose-built modules live in `src/admin/`, one file per domain, each
exporting `{ router }` and mounted under `/admin` in `server.js`:
`modules.js` (users/content/analytics/broadcast/flags/impersonation/audit),
`relationships.js` (Phase 5 lifecycle + purge controls), `intakeProfiles.js`
(Phase 8, read-audited), `progressionAdmin.js` (Phase 9),
`workoutContent.js` (Phase 6), `nutritionAdmin.js` (Phase 7 incl. allergen
consistency check), `syncHealth.js` (Phases 10-11), `analyticsExtra.js`
(Phase 12 + password reset / per-user sync overview).

### Tests

`npm test` runs `node --test test/` against the real database: auto-discovery
(a throwaway table appears in `/admin/schema`; a throwaway registerRoute()
appears in `/admin/api-registry`), sensitive-column masking, table-name
rejection before query, and one RBAC boundary per role (analyst/read_only
writes → 403; super_admin control case → 200).

### Admin Management section (migration 035) — testing area

Isolated new dashboard tab (`/admin/mgmt/*`, frontend "Admin Management"):

- **Global progression defaults**: `progression_formula_globals` stores one
  admin-set param row per formula key. `progression.js` merges it OVER schema
  defaults and UNDER any explicit trainer/user params — so edits reach every
  user without personal overrides, and historical calculations are never
  rewritten. Params are validated against each formula's `paramSchema`
  (structured numbers/booleans only — no expressions can be injected).
- **Global exercise library**: admin-only create/edit; DELETE is always a
  SOFT archive (`is_archived`), never a hard delete — exercise references are
  name-based across templates/plans/history, so archiving preserves
  everything. Duplicate names rejected case/whitespace-insensitively.
- **Unified user management**: `/admin/mgmt/users/:id/overview|workouts|
  custom-exercises|diets|dishes|recipes|supplements|nutrition|progression|
  analytics` — every query hard-scoped by user/client id (cross-user leakage
  is covered by tests). Reads: support+; ALL writes: super_admin only;
  writes audited.

### Server-authoritative exercise catalog

The mobile app renders its exercise library from THIS backend, not a bundled
seed: `GET /exercises/catalog` (auth required) serves every non-archived
global exercise with the same muscle-group mapping the app expects, and
`GET /exercises/catalog/meta` returns a cheap version string so devices only
re-download when the library changes. The app syncs at login into its local
SQLite cache (`src/lib/exerciseCatalog.js`) — offline usage keeps working off
that cache. Admin-created/archived exercises in the Admin Management section
flow to all devices on their next sync.

### Forgot / reset password (migration 034)

Self-service flow, fully independent of admin tooling:

- `POST /auth/forgot-password` `{email}` → ALWAYS returns
  `"If an account exists for this email, a password reset link has been sent."`
  (account enumeration is impossible from the response; SMTP failures are
  logged server-side and do not change the response).
- `POST /auth/reset-password` `{token, password}` → consumes a single-use
  256-bit token (only its SHA-256 hash is stored in
  `password_reset_tokens`), expires per
  `PASSWORD_RESET_TOKEN_EXPIRY_MINUTES` (default 30), revokes all of the
  user's refresh tokens inside the same transaction as the password update.
- Email transport is abstracted (`src/email/provider.js`); Gmail SMTP is
  just the current provider (`src/email/smtpProvider.js`, Nodemailer,
  STARTTLS). Swap providers by registering a new one — business logic never
  changes. Requires a Gmail **App Password** (2-Step Verification), set via
  `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` in root `.env`.
- Reset link: `${APP_SCHEME}://reset-password?token=…` deep link into the
  mobile app (falls back to `FRONTEND_URL` when no scheme is set). The app's
  AuthStack handles `ForgotPassword` and `ResetPassword` screens; the token
  can also be pasted manually.
- Abuse controls (`src/middleware/rateLimit.js`, in-memory fixed window):
  forgot-password 10/hr per IP + 3/hr per email; reset-password 20/hr per IP.
- Tests: `test/passwordReset.test.js` covers the full matrix (enumeration
  equivalence, normalization, expiry, single-use, invalidation-of-older,
  refresh-token revocation, rate limiting) with the mailer stubbed.

### Sync/restore telemetry (migrations 032)

The device sync engine posts throttled queue-health snapshots to
`POST /sync/report` and restore flows open/close runs via
`POST /sync/restore-run/start|finish` — all fire-and-forget from the app
(`src/lib/adminTelemetry.js`); these tables feed the admin Sync & Restore
dashboard and are never on an app critical path.

Notables: generic table names are validated against the live schema before
any query (no injection); suspended users are blocked at app login;
impersonation tokens carry `impersonation: 'read_only'` and ALL mutating
verbs made with them are rejected by the app's auth middleware;
`GET /config/feature-flags` is public for the mobile app.

## Exercise Alternatives (migration 028)

Three mirrored tables, deliberately NOT unified into one polymorphic table
(exercise entries live in three separate parent tables — local SQLite
plan_exercises, workout_template_exercises, assigned_plan_exercises — and
the codebase duplicates matching structures across local SQLite/Postgres by
pattern):

- `workout_template_exercise_alternatives` (template library)
- `assigned_plan_exercise_alternatives` (specific client assignments)

Validation lives in `src/data/alternatives.js`: max 3 alternatives per
exercise entry and no duplicates (primary or siblings, case-insensitive).
A 4th alternative or duplicate is REJECTED with 400 ("X is already added
as an alternative") on any create/update endpoint accepting an
`alternatives` array — never silently truncated.

**Snapshot rule**: `assignFromTemplate` copies the template's CURRENT
alternatives into assigned_plan rows. Editing the template afterward does
not retroactively change existing assignments — same snapshot-only
behavior as sets/reps/rest. Template delete stays safe: assignment
snapshots are independent rows.

**Swap mechanism** is session-local only on the mobile side; the backend's
only involvement beyond the two tables above is
`session_exercise_details.original_exercise_name` (migration 028) — set
from the per-set detail sync payload when a client swapped an exercise
mid-session, NULL when performed as planned, surfaced to trainers in the
drill-down endpoint.

Manual test notes live in the mobile README under "Exercise Alternatives +
Mid-Session Swap".

## Diet Dish Alternatives + Date-Scoped Swaps (migration 029)

Mirrors migration 028 for diet plans. Meal items have only TWO structural
homes (there is no reusable diet template library — the trainer's
`meal_catalog_items` catalog is the reusable part, not whole plans):

- `diet_plan_meal_item_alternatives` (trainer-assigned plans; FK to
  `diet_plan_meal_items` ON DELETE CASCADE, optional reference-only
  `alternative_catalog_item_id`)
- local SQLite `local_diet_plan_meal_item_alternatives` on the device for
  self-authored plans (see mobile README)

plus an `alternatives JSONB` column on `backup_diet_plan_meal_items`
(029) so self-authored plan backups/restores carry alternatives inside the
item payload without a third relational table.

Validation in `src/data/dietAlternatives.js`: max 3 per dish, no duplicates
(primary or siblings, case-insensitive) → 400, never truncated. Wired into
both `createDietTree`/`updateOwnDietPlan` (trainer assign / client edit)
and `upsertDietPlan` (backup payload). **Snapshot rule**: alternative
macros are copied at add time; editing a catalog dish later never changes
an already-configured alternative — consistent with every other
catalog-sourced value.

### Date-scoped swaps — READ THIS BEFORE ASSUMING THEY WORK LIKE WORKOUT SWAPS

A workout swap is SESSION-scoped: one session, logged once. A diet plan is
followed repeatedly day after day, so `diet_item_swaps` keys each swap to
an exact calendar date (`UNIQUE(user_id, diet_plan_meal_item_ref,
swap_date)`): "on 2026-08-24 the client ate X instead of Y". The plan's own
definition and every other day are untouched.

Deliberate schema choices (do not "normalize" these away):

- **No FK on `diet_plan_meal_item_ref`** and **`original_name` snapshotted**
  — a swap is a historical record of what actually happened and must
  survive the original item later being edited or removed from the plan.
- `plan_server_id` is NULL for self-authored-plan swaps, set only for
  trainer-assigned ones. All swaps sync privately via `/user/backup/
  diet-swaps` (POST upsert / GET list / DELETE by item+date, idempotent).
  Trainer visibility is a SEPARATE concern: `listAssignedPlanSwaps` joins
  `diet_plans` on trainer+client ownership and can therefore never return a
  self-authored swap. Surfaced as `recent_swaps` inside
  `GET /trainer/clients/:id/diet-plans/:planId`.

### Manual test sequence (curl)

```bash
# 1. Assign a plan with configured alternatives (trainer)
curl -X POST $API/trainer/clients/$CLIENT_ID/diet-plans \
  -H "$TRAINER_AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Push Day Nutrition","days":[{"day_label":"Every Day",
    "meals":[{"meal_type":"Breakfast","items":[{"catalog_item_id":"'$OATMEAL_UUID'",
      "alternatives":[{"name":"Greek Yogurt Parfait","calories":280},
                      {"catalog_item_id":"'$PANCAKES_UUID'"]}]}]}]}]}'
# NEGATIVE: same call with 4 alternatives or a duplicate name → 400
# ("Up to 3 alternatives per dish" / "already added")

# 2. Plan detail carries alternatives + recent_swaps: []
curl $API/trainer/clients/$CLIENT_ID/diet-plans/$PLAN_UUID -H "$TRAINER_AUTH"

# 3. Client swaps Oatmeal → Greek Yogurt Parfait for today (sync queue does
#    this automatically; shown here directly)
curl -X POST $API/user/backup/diet-swaps -H "$CLIENT_AUTH" \
  -H 'Content-Type: application/json' \
  -d '[{"plan_ref":"'$PLAN_UUID'","plan_server_id":"'$PLAN_UUID'",
        "diet_plan_meal_item_ref":"'$ITEM_UUID'","swap_date":"2026-08-24",
        "original_name":"Oatmeal","swapped_name":"Greek Yogurt Parfait",
        "swapped_calories":280}]'

# 4. Trainer now sees history with correct date + before/after names:
curl $API/trainer/clients/$CLIENT_ID/diet-plans/$PLAN_UUID -H "$TRAINER_AUTH"
#    → recent_swaps: [{swap_date: 2026-08-24, original_name: Oatmeal, ...}]

# 5. NEGATIVE — self-authored swap must NOT reach any trainer route:
curl -X POST $API/user/backup/diet-swaps -H "$CLIENT_AUTH" \
  -H 'Content-Type: application/json' \
  -d '[{"plan_ref":"dp_local_123","diet_plan_meal_item_ref":"dp_local_x",
        "swap_date":"2026-08-25","original_name":"Oatmeal",
        "swapped_name":"Toast","plan_server_id":null}]'
#    row exists privately (GET /user/backup/diet-swaps), but step 4's
#    recent_swaps cannot include it (plan_server_id NULL → join misses).

# 6. Undo = idempotent delete (never 404-loops):
curl -X DELETE $API/user/backup/diet-swaps/$ITEM_UUID/2026-08-24 -H "$CLIENT_AUTH"
```

More scenarios (multi-item slots, repeated dish names across days,
past-date undo, check-in independence, snapshot isolation, theme checks)
live in the mobile README under "Diet Dish Alternatives + Date-Scoped
Swap".

## Trainer-Shared Exercise Notes (migration 030)

DELIBERATE, DOCUMENTED EXCEPTION to the redacted trainer sync. The
session-detail layer intentionally stores no subjective data ("RPE and
notes never included") — that rule still holds for RPE and PERSONAL notes.
Migration 030 adds exactly one client-authored field that does travel:

- `session_exercise_details.shared_note` — the user's explicit
  "Share with Trainer" text per exercise (client detail payload maps it
  from `trainer_note` on the device; capped at 2000 chars, everything else
  still stripped defensively in `upsertSessionDetails`)
- `backup_session_exercises.trainer_note` — same field under its device
  name, keeping the full-fidelity personal backup lossless

Trainer surface: `getDetailsForSummary` returns `shared_note`; rendered as
"Note from client" in the mobile Client Detail drill-down. Never map
personal notes or RPE into this column.

Manual test notes live in the mobile README under "Exercise Comment
Tick-Save + Trainer-Shared Notes".

## Workout Plan Backup Fidelity (alternatives)

`client_workout_plans.exercises` JSONB elements may now carry an
`alternatives: string[]` field (configured swap options per exercise).
Validated in `upsertTemplates` via `normalizeAlternatives` — max 3,
case-insensitive duplicates rejected with 400, never truncated. Returned
verbatim by `listForClient`; device restore rebuilds
`plan_exercise_alternatives` from it (mobile migration v32 force-resyncs
pre-existing routines once). Mirrors the diet `alternatives` JSONB rule.
