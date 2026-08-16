# Workout Tracker (Hevy-style)

A React Native (Expo SDK 51) workout logger and tracker. All data is stored locally with SQLite.

## Features

- **Live workout session** — start empty or from a routine, live timer, add exercises/sets, log weight & reps, workout notes, finish/save/discard.
- **Previous performance** — when adding an exercise mid-workout, your last sets are pre-filled as a starting point, with live delta indicator showing weight/reps changes vs. previous session.
- **Routines (plans)** — create reusable workout templates with target sets, per-exercise rest times, and superset groups; one-tap start.
- **History** — browse past sessions with duration, exercise count, volume; view full session detail; tap sets to retroactively change type; delete sessions. PR badges 🏆 on sets that set personal records.
- **Progress** — per-session volume & set charts, weekly stats, consistency heatmap, streak counter, and per-exercise tracking: estimated 1RM (Epley), RPE trend line with readiness insights, max weight, total volume, volume chart, and per-session set history with PR badges.
- **Exercise library** — ~38 seeded exercises plus custom exercise creation, searchable and filterable by muscle group.
- **Rest timer** — auto-starts after completing a set (per-exercise or global default). Persistent pill bar with mm:ss countdown, −15s/+15s adjust, skip. Schedules a local notification (via expo-notifications) for backgrounded timers. Persists end-timestamp so a cold launch can restore a still-running timer. expo-keep-awake prevents screen sleep during active workouts only.
- **Superset / circuit grouping** — link 2+ exercises into a superset in the routine editor or live session. Visual bracket/connector, group label (Superset A, B…). Toggle "rest after full round" per group. Unlink individual exercises. Deleting one exercise from a 2-exercise group auto-clears the sibling's group.
- **Set types** — each set gets a type: Working (W), Warm-up (WU), Drop set (DS), Failure (F). Warm-up sets are visually de-emphasized and excluded from all volume, 1RM, and PR calculations. Drop set / failure sets are included in volume but flagged in history. Tap any set row in session detail to retroactively cycle its type.
- **RPE per set** — optional RPE chips (6–10 in 0.5 increments) appear after marking a set complete. Fully optional at every entry point. RPE trend chart per exercise on the progress screen. Auto-generated insight when RPE suggests progression or load reduction. Toggle on/off in Settings.
- **Plate calculator** — per-side plate breakdown for any entered weight. Bottom sheet from a small icon on each set's weight input. Handles both kg and lb independently. Greedy largest-first algorithm with remainder reporting. Configurable bar weight and plate inventory in Settings.
- **Personal records (PRs)** — automatic PR detection on completing a working set. Celebrates with animated toast + haptic feedback. PR badges shown on history sets. Supports: max weight, estimated 1RM, max volume set, max reps at weight (per unique weight). Backfilled from existing data on first run; demotes to next-best when PR-holding set is deleted.
- **Body tracking** — log body weight and measurements (waist, chest, hips, arms, thighs, neck, body fat %). Charts show trends over time. Date picker allows logging past entries.
- **Progress photos** — capture photos via camera or library, stored in app documents directory. Grid view grouped by date. Tap to view full-size; select any two photos for side-by-side comparison.
- **Streaks & consistency** — current streak and longest streak displayed on home and progress screens. Calendar heatmap (GitHub-style) shows workout days, shaded by volume. Timezone-aware day boundaries.
- **Settings** — units (kg/lb), default rest seconds, RPE toggle, bar weight, plate inventory, streak tolerance (rest days allowed).

## Run

```bash
npm install
npx expo start
```

Then scan the QR with Expo Go, or press `i` / `a` for the iOS / Android simulator.

## Tests

```bash
npm test
```

Pure-Node unit tests for plate calculator math, e1RM/Epley formula, RPE averaging (NULL-safe), and RPE insight generation.

## Tech

- Expo SDK 51, React Native 0.74
- expo-sqlite for persistence (WAL mode, versioned migrations)
- expo-notifications for rest-timer background notifications
- expo-keep-awake to prevent screen sleep during workouts
- React Navigation (bottom tabs + native stack)
- react-native-svg for charts (lightweight custom line chart)
- React Context + useReducer for the in-progress workout state

## Schema

### `exercises`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT UNIQUE | |
| muscle_group | TEXT | |
| is_custom | INTEGER | 0 = seeded, 1 = user-created |

### `workout_plans`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| notes | TEXT | nullable |
| created_at | INTEGER | unix ms |

### `plan_exercises`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| plan_id | INTEGER FK | → workout_plans |
| exercise_id | INTEGER FK | → exercises |
| position | INTEGER | order in plan |
| target_sets | INTEGER | default 3 |
| rest_seconds | INTEGER | default 90 (v2 migration) |
| group_id | TEXT | nullable, superset group UUID (v3 migration) |

### `workout_sessions`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| start_time | INTEGER | unix ms |
| end_time | INTEGER | nullable |
| duration_sec | INTEGER | nullable |
| notes | TEXT | nullable |
| plan_id | INTEGER FK | nullable, → workout_plans |

### `session_exercises`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| session_id | INTEGER FK | → workout_sessions |
| exercise_id | INTEGER FK | → exercises |
| position | INTEGER | order in session |
| rest_seconds | INTEGER | default 90 (v2 migration) |
| group_id | TEXT | nullable, superset group UUID (v3 migration) |

### `sets`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| session_exercise_id | INTEGER FK | → session_exercises |
| weight | REAL | |
| reps | INTEGER | |
| is_warmup | INTEGER | legacy flag, carried to set_type in v5 |
| position | INTEGER | order within exercise |
| rpe | REAL | nullable, 6–10 (v4 migration) |
| set_type | TEXT | 'working', 'warmup', 'dropset', 'failure'; default 'working' (v5 migration) |

### `user_settings`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | always 1 (singleton row) |
| default_rest_seconds | INTEGER | default 90 |
| rpe_enabled | INTEGER | 1 = on, 0 = off |
| unit | TEXT | 'kg' or 'lb' |
| bar_weight | REAL | default 20 (kg) or 45 (lb) |
| plates | TEXT | JSON array of plate sizes |
| rest_timer_ends_at | INTEGER | persisted timer end timestamp (nullable) |
| rest_timer_total | INTEGER | persisted timer duration (nullable) |
| rest_timer_label | TEXT | persisted timer label (nullable) |
| streak_tolerance | INTEGER | allowed rest days between workout days (default 1) |

### `personal_records`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| exercise_id | INTEGER FK | → exercises |
| record_type | TEXT | 'max_weight', 'max_reps_at_weight', 'max_volume_set', 'estimated_1rm' |
| value | REAL | |
| secondary_value | REAL | reps (for max_reps_at_weight) or weight (for max_volume_set) |
| set_id | INTEGER FK | → sets |
| achieved_at | TEXT | ISO timestamp |

### `body_metrics`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| date | TEXT | ISO date (YYYY-MM-DD) |
| metric_type | TEXT | 'weight', 'body_fat_pct', 'waist', 'chest', 'hips', etc. |
| value | REAL | |
| unit | TEXT | 'kg', 'lb', 'cm', 'in', '%' |

### `progress_photos`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| date | TEXT | ISO date |
| file_path | TEXT | relative path within documents/progress_photos/ |
| angle | TEXT | nullable: 'front', 'side', 'back' |
| created_at | TEXT | ISO timestamp |

## Migrations

Versioned in `src/db/db.js` using `PRAGMA user_version`. Each migration runs exactly once:

| Version | Changes |
|---|---|
| v1 | Baseline schema (exercises, plans, sessions, sets) |
| v2 | `rest_seconds` on plan_exercises + session_exercises; `user_settings` table |
| v3 | `group_id` on plan_exercises + session_exercises (superset support) |
| v4 | `rpe` on sets |
| v5 | `set_type` on sets; backfills from legacy `is_warmup` flag |
| v6 | `personal_records` table with backfill |
| v7 | `body_metrics` table |
| v8 | `progress_photos` table |
| v9 | `streak_tolerance` on user_settings |

Existing users' databases upgrade cleanly with no data loss — every new column has a safe default.

## Ideas for next steps

- Export/backup (JSON), cloud sync
- Workout templates shared between users
- Animated rest timer circle

## Mini-Player Interaction Model (Tier 4)

- **Persistent mini-bar** (`src/components/ActiveWorkoutMiniBar.js`): visible on every screen
  whenever a workout is active (in progress or paused); hidden entirely otherwise. Shows workout
  name, live elapsed time (recomputed from the stored start timestamp, never an in-memory
  counter), completed-set count, and inline pause/resume (plus discard while paused). Tapping
  anywhere on the bar expands the full logging view (`ActiveWorkout`, a full-screen modal).
- **Expanded view controls**: pause/resume, restart (clears logged sets + timer, keeps the
  exercise list; asks for confirmation), end & save, and discard. Collapse via the chevron-down.
- **No Workout tab**: starting/managing workouts happens through the mini-bar. Tabs are
  Home, History, Plans, Progress. All former `navigate('Workout')` calls expand the mini-bar view.
- **Home start flow**: "Start Workout" opens a choice sheet — Start Empty Workout or pick a
  routine — then drops you straight into the expanded logging view.
- **Settings** entry is a gear icon in the Home screen header only.
- **Session persistence**: the active workout (including pause state) is serialized to the
  `active_workout` table on every change and restored on launch, so killing and reopening the
  app mid-workout restores the session and mini-bar.

## Tier 4 behavior notes

- **Previous performance as placeholders**: last session's weight×reps shows in the LAST column
  and as native placeholder text in empty inputs. Placeholder-only sets never count as filled:
  they don't contribute to volume, completion, or PR detection. Tap the LAST cell to quick-fill
  both fields with the previous values.
- **Per-exercise notes**: chatbox icon on each exercise header in the expanded view (outline =
  empty, filled = has note). Stored on `session_exercises.notes`, shown in session detail under
  the exercise name, separate from the whole-workout note.
- **Volume excludes not-done sets**: every volume/PR/streak SQL aggregate and the live running
  total filter `sets.completed = 1` in addition to `set_type != 'warmup'`. The done toggle is
  bidirectional — un-marking a set removes it from the live total immediately.
  Legacy sets default to `completed = 1` so historical stats don't change after upgrade.
- **Icons**: all UI chrome icons use Ionicons (`@expo/vector-icons`); muscle groups use custom
  SVG glyphs (`src/components/MuscleIcon.js`) rendered with react-native-svg.
- **Migrations v13–v15**: `session_exercises.notes`, `sets.completed`, `active_workout` table.

## Manual test notes (Tier 4)

1. **App-kill restoration**: start a workout, log a set, kill the app, reopen → mini-bar
   reappears with elapsed time continuing from the stored start timestamp; sets intact.
2. **Volume excludes not-done sets**: type weight/reps without tapping done → running "vol" in
   the header does not change; tap done → updates immediately; tap done again (un-mark) →
   decreases again. History/Progress volume matches after save.
3. **Placeholders don't submit**: leave a set showing only placeholder values → finish warns
   "mark at least one set done"; the set is not counted in volume or PRs after save.
4. **Tab navigation during workout**: switch between History/Plans/Progress during an active
   workout → mini-bar persists, pause/resume still work, state unchanged.
5. **Restart**: confirm dialog appears; accepting clears sets/timer but keeps exercise list.

## Tier 5: Headers, Sharing, Empty-Workout Flow

- **Fixed headers**: every screen uses React Navigation's native headers (tab headers for
  Home/History/Routines/Progress, stack headers for detail screens). Titles never scroll with
  content and don't flicker on tab transitions. The Home header carries the settings gear
  (headerRight, Home only). The expanded logging view keeps its own fixed top bar
  (name/timer/controls), consistent with the pattern.
- **Routine sharing** (`src/lib/share.js`): share icon in the Routine detail header and in each
  completed session's detail header. Generates plain text (exercise order + sets/reps/weight)
  and hands off to the OS share sheet via React Native's `Share.share`. Privacy: session notes,
  per-exercise notes, RPE, timestamps/durations, body metrics, and photos are never included —
  only the workout structure.
- **Empty-workout naming + save-as-routine**: the Start Workout choice sheet includes a name
  field prefilled with a smart default ("Wednesday Workout"). Routine-started workouts default
  to the routine's name (renamable any time by tapping the name in the expanded view). On
  finish, empty-started workouts choose "One-time Only" or "Save as Routine" in the same finish
  dialog (one tap); Save as Routine creates a workout_plans row with target sets equal to the
  sets actually performed. Routine-started workouts keep the original two-choice finish flow
  unchanged.

### Manual test notes (Tier 5)

1. **Sharing excludes private data**: log a session with workout notes, per-exercise notes, and
   RPE values; open it in History → tap the share icon → the shared text contains only exercise
   names and weight×reps — no notes, no RPE, no dates/durations.
2. **Save-as-routine round trip**: start an empty workout (accept the default name), log sets
   on 2–3 exercises, finish → "Save as Routine" → the new routine appears in Routines with
   matching exercises/sets → start it immediately and log a full session end-to-end.
3. **Fixed headers**: scroll a long History list and the full exercise library — titles stay
   pinned; switch tabs rapidly — no title flash.

## Accounts & Roles (backend + auth gate)

The app now has a user-accounts system with two roles (user, trainer), backed
by a separate Node.js/Express + Postgres service in `backend/`. The app is
**login-gated**: on launch it shows a splash while restoring tokens from
expo-secure-store, then either the Login/Signup flow or the main app — there
is no unauthenticated path. Signup includes a role choice ("I'm a User" /
"I'm a Trainer").

- Auth: JWT access token (30 min) + rotating refresh token (30 days, stored
  server-side in `refresh_tokens` so logout revokes it). The API wrapper
  (`src/lib/api.js`) attaches the access token and performs exactly one
  silent refresh on 401 before forcing logout.
- Logout lives in Settings → Account (Settings stays reachable from the Home
  header only, per the earlier UX decision).
- Trainer-role accounts see an extra **Clients** tab — a clearly-labelled
  DEMO/preview screen with static fake clients, a fabricated volume chart
  (reusing the app's chart component), and a non-functional "Assign Workout"
  button. It is deliberately NOT wired to the real backend endpoints.
- Local-first is preserved: all workout logging data still lives in local
  SQLite and is never synced in this pass.

**Requires the backend running locally** (with its own Postgres) for login to
work — see `backend/README.md` for setup and a full curl test sequence. Point
the app at it via `EXPO_PUBLIC_API_URL` (defaults to `http://10.0.2.2:4000`
for the Android emulator; use your LAN IP for a physical device).

## Background Session-Summary Sync (invisible)

Aggregate session summaries sync to the backend automatically — no UI, no
change to how saving a workout feels:

- `workout_sessions.synced` (default 0) + `sync_attempted_at` (migration v16).
- On finish-save, `queueSessionForSync(sessionId)` (`src/lib/syncService.js`)
  attempts one immediate POST if online. Offline/failure is swallowed — the
  row stays unsynced.
- On app foreground (and right after auth), `syncPendingSessions()` batches
  every unsynced session into one POST and marks them synced. NetInfo gates
  both paths.
- Retroactively changing a set's type in History flips that session's
  `synced` back to 0, so the corrected totals re-sync on next foreground.
- Aggregates exclude warmup and not-completed sets, matching every other
  volume calculation in the app.

Manual test notes:
1. Airplane mode + finish a workout → saves instantly, no error.
2. Network back on + foreground the app → session appears in Postgres
   `session_summaries` within seconds, no user action.
3. Edit a synced set's type in History → `session_summaries.total_volume` /
   `working_set_count` update after next foreground (row count stays 1).
4. Force-quit mid-sync → the session either synced or remains unsynced and
   is retried; never lost, never duplicated (upsert on local_session_id).

## Phase 3 — Live Clients tab + association flow

- The trainer's **Clients** tab now fetches real data (`GET /trainer/clients`
  + `GET /trainer/associations?status=pending`) with pull-to-refresh and a
  loading spinner; the "(Preview)" suffix and banner are gone and no mock
  data remains. Active cards show real `adherence_pct` and relative
  `last_active_at` ("2 days ago", or "No workouts yet" when null). Tapping a
  card opens `ClientDetail` (placeholder detail view until Phase 4).
- **Pending section** above the active list: dashed/outlined muted cards with
  inline Accept/Reject buttons (optimistic update, rolled back on failure).
- **Invite code**: the empty state offers "Show My Invite Code" (POST
  /trainer/invite-code) with a share sheet action.
- **Client side**: Profile → Trainer card for user-role accounts — shows
  current state (None / Request pending / connected trainer name), an invite
  code input, and a Connect button calling POST /client/associations/request.
  Errors ("Invalid or expired invite code", "Request already pending",
  "Already connected", "You already have an active trainer") display inline
  without wiping the input; success shows "Request sent to [name]".
- Backend: new `POST /client/associations/request` (user-role only; trainer
  resolved from the invite code server-side, ids never trusted) with
  idempotent duplicate/one-trainer-per-client rules, and
  `GET /client/trainer` now returns the association state
  (active/pending + trainer name) so clients see the pending state.

## Phase 5 — Assign Workouts (trainer → client)

- **Assign Workout** on Client Detail opens the same builder UI as personal
  Routines (name, notes, superset linking, exercise cards with set stepper +
  rest chip, add-exercise picker) — only the title ("Assign to [Client]") and
  save button ("Assign Workout") differ. On save it POSTs
  `/trainer/clients/:id/assigned-plans`, returns to Client Detail, and shows a
  "Workout assigned to [Client]" toast; the Assigned Workouts section
  refreshes on focus, so the new plan appears immediately.
- **Assigned Workouts** section (between Recent Workouts and the Assign
  button) lists active plans (name, exercise count, date assigned); tapping
  opens a read-only detail reusing the Routine Detail layout, including
  superset labels and rest chips. **Archive** (outlined red button with
  confirm) PATCHes `status='archived'` — the row stays in Postgres, leaves
  the active list, and the list refreshes on return.
- Backend: `POST/GET /trainer/clients/:clientId/assigned-plans` and
  `PATCH /trainer/clients/:clientId/assigned-plans/:planId` (status-only),
  all trainer-only with the active-association guard; PATCH additionally
  verifies the plan belongs to that trainer+client pair. Migration 006 adds
  `assigned_plan_exercises.group_id` so superset structure carries over.

Test via curl (negative case): POST an assigned plan to a client your
trainer has no active association with → 403 "No active trainer-client
association for this pair".

## Phase 6 — Client-facing assigned workouts

- **"From Your Trainer"** section on Home (user-role only, rendered only
  when active assignments exist — hidden entirely otherwise), positioned
  between the streak and Routines. Same card family as everything else,
  differentiated by a blue left-edge accent, a coach icon on the section
  label, and "Assigned by [Trainer] · N exercises" metadata. Data from
  `GET /client/assigned-plans` (client-only; active plans with exercises +
  trainer name), refreshed on every Home focus — no manual pull needed.
- **Read-only detail** (`ClientAssignedDetailScreen`): Routine Detail layout
  with a "Assigned by [Trainer]" banner, full exercise list (target
  sets/reps, rest chips, superset grouping, trainer notes), and a Start
  Workout CTA. Starting resolves each plain-text exercise name to a local
  SQLite exercise (creating a custom entry if the client doesn't have it)
  and feeds the standard live-session flow — mini-bar, logging, Phase 2
  sync, History — identical to starting one of the client's own routines.

## Routines tabs + trainer/self-made color coding

- **Routines screen**: client accounts get a segmented control beneath the
  header — "My Routines" (local plans, unchanged) and "From Trainer" (active
  assigned plans, same card structure with a blue accent stripe and
  "Assigned by [Trainer]" line, tapping opens the read-only detail with Start
  Workout). Both tabs always exist for role='user'; the empty state
  ("Nothing assigned yet") is the default. Trainer accounts see the single
  self-made list as before.
- **Home simplified**: the "Quick Start — Routines" and "From Your Trainer"
  sections are gone; Recent Workouts (now 6 entries) is the main content
  below the CTA/streak. Routines of both kinds live in the Routines tabs.
- **Color-coding system**: sessions started from an assigned plan store
  `workout_sessions.source_assigned_plan_id` (migration v17, set on start,
  null otherwise) — the flag drives everything, no runtime guessing.
  Trainer-origin sessions show a blue left-edge stripe PLUS a fitness-icon
  "Trainer" label on Home Recent, History cards, and a "From your trainer"
  badge on Session Detail (never color alone). Self-made sessions stay
  unmarked — the same one-flagged-category treatment on all three screens.

## Pinned Routines + Recent cap (Home)

- **Pins** (`src/db/pins.js`, migration v18): a `pinned_routines` table spans
  both sources — `self` (local workout_plans ids) and `trainer_assigned`
  (backend assigned_plans UUIDs) — with `MAX_PINNED_ROUTINES = 6` enforced
  across both combined. Pin toggles (outline → filled+accent) sit on every
  card in BOTH Routines tabs and work straight from the list; hitting the cap
  alerts "You can pin up to 6 routines — unpin one first" instead of failing
  silently. `order_index` is stored for future drag-reorder.
- **Home Pinned strip**: a horizontal row of compact cards between the
  streak and Recent Workouts, omitted entirely when empty. Pinned
  trainer-assigned cards keep the blue stripe + "Trainer" marker (color
  coding stays consistent); self-made use the default accent. **Tapping
  starts the workout directly** — no detail-screen step — with full prefill
  via the shared `startAssignedPlan`/routine start paths. **Long-press
  offers Unpin** so pins can be managed from Home.
- **Stale-pin cleanup**: on every Home load, pins whose source routine was
  deleted (self) or revoked/archived (trainer — checked against the current
  GET /client/assigned-plans response) are silently removed; broken cards
  never render.
- **Recent Workouts capped at 7** with a "see all" link in the section
  header navigating to the full History tab; color coding unchanged.

### Manual test notes

1. Pin 6 routines across both tabs; a 7th attempt alerts the cap message and
   changes nothing. Unpin one, then pin succeeds.
2. Pin one self-made + one trainer-assigned routine; both render on Home
   with the correct accent/icon coding.
3. Tap a pinned card → lands directly in the live session with the routine's
   exercises/sets/rest prefilled (zero intermediate screens).
4. Long-press a pinned card on Home → Unpin removes it; also toggle the pin
   icon on the Routines tab.
5. As the trainer, archive an assigned plan that's pinned on the client →
   the client's next Home load silently drops the stale pin.

## Analytics, Drill-down & Coaching Plans

**Backend** (run `npm run migrate` in `backend/` — migrations 007-009):
- `measurement_entries` (synced mirror of local body_metrics) and
  `session_exercise_details` (per-set drill-down as JSONB — structural only:
  set_number/weight/reps/set_type/completed; RPE and notes are never synced).
- `POST /client/measurements` (batch upsert), `POST /client/session-exercise-details`
  (upsert keyed to server summary ids), trainer GETs:
  `/clients/:id/measurements?metric_type=&from=&to=`,
  `/clients/:id/measurement-types`, `/clients/:id/exercises`,
  `/clients/:id/strength?exercise=&from=&to=` (Epley e1RM per session, SQL),
  `/clients/:id/sessions/:summaryId/details`; session-summaries now accepts
  `from`/`to`.
- `diet_plans`/`diet_plan_items`/`diet_checkins` and the supplement mirror —
  full trainer CRUD + client view/check-in endpoints (one generic
  `coachingPlans.js` data module; active-association enforced everywhere).
- Invite codes are single-use (migration 005, atomically claimed).

**Mobile sync**: measurement rows carry a `synced` flag (migration v19);
foreground catch-up batch-pushes body metrics, and the session-summary sync
now follows up with the per-set detail payload mapped to server summary ids.
Retroactive set-type edits flip `synced = 0`, re-syncing summary + detail.

**Trainer Client Detail**: analytics tabs (Volume / Strength / Measurements)
with a Week/Month/Custom range control (persists across tab switches),
reusable capsule dropdowns (exercises derived from synced detail; metric
types from actual data), loading states between chart fetches; content tabs
(Workouts / Diet / Supplements): accordion Recent workouts with fetch-once
drill-down cache, Assigned list + Assign Workout relocated into the tab,
Diet/Supplements lists with builders (routine-builder pattern), plan detail
with a 4-week adherence strip (grey = no check-in, never implied "missed")
and archive.

**Client Coaching**: Home shows a "Coaching" card (only when diet/supplement
plans exist) → Coaching screen with Diet/Supplements tabs, plan/meal
expansion, single-tap daily check-ins (long-press adds an optional note),
and a personal 14-day strip.

### End-to-end test

1. Client logs a workout with RPE + notes → trainer expands the session in
   Client Detail: sets match; RPE/notes absent (also inspect the JSONB in
   psql: `SELECT sets FROM session_exercise_details`).
2. Trainer: Strength tab → pick exercise → e1RM trend over range; Volume/
   Measurements tabs re-query per range.
3. Trainer assigns a diet plan (Diet tab → Assign Diet Plan → add meals).
4. Client: Coaching card on Home → check in "yes" (long-press → note).
5. Trainer reopens the plan detail: today's strip cell is green.
