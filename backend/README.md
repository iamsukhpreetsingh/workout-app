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

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /client/session-summaries | any user | batch upsert on (client_id, local_session_id); client_id comes from the token |
| GET | /trainer/clients/:clientId/session-summaries | trainer | 403 without an active association; `?limit=20&offset=0` |
| GET | /trainer/clients | trainer | now includes `adherence_pct` + `last_active_at` per client |

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
