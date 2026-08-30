# Workout Tracker — Mobile App (Frontend)

React Native (Expo SDK 51) application for personal workout logging and
nutrition tracking, with an optional trainer–client relationship where the
trainer monitors and coaches. Local-first: everything the user creates is
written to on-device SQLite first and synchronized to the backend when
network is available.

Companion docs: [`backend/README.md`](backend/README.md) (API + server),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (short architecture map).

---

## 1. Tech Stack

| Concern | Choice |
|---|---|
| Framework | Expo SDK 51 · React Native 0.74 · React 18 |
| Language | JavaScript (no TypeScript in the app) |
| Navigation | `@react-navigation/native` 6 — bottom tabs + native stacks |
| Local database | `expo-sqlite` (single `workout.db`, numbered migrations) |
| Charts | `react-native-svg` (custom `LineChart` / `BarChart` components) |
| Icons | `@expo/vector-icons` (Ionicons) |
| Secure storage | `expo-secure-store` (auth tokens + user) |
| Notifications | `expo-notifications` (rest-timer + push tokens) |
| Photos | `expo-image-picker` + `expo-image-manipulator` |
| State | React Context: `AuthContext`, `AppContext`, `WorkoutContext`, `NotificationContext` |

**Not used**: TypeScript, Redux/Zustand (contexts suffice), Reanimated,
third-party auth SDKs — auth is JWT against our own backend.

---

## 2. Setup

```bash
npm install
# .env (read by app.config.js — there is NO app.json):
#   USE_LOCAL=true|false
#   API_URL_LOCAL=http://192.168.x.x:4000     # device on same LAN as backend
#   API_URL_REMOTE=https://your-server:4000
npx expo start            # dev
npm test                  # pure-logic unit tests (plain Node)
npm run lint              # eslint — 0 errors required (prettier warnings are legacy noise)
npx expo export --platform android --output-dir /tmp/bundle-check   # full compile check
```

`app.config.js` is the single live config (env-driven API URL, plugins:
`expo-font`, `expo-secure-store`, `./plugins/withAndroidNetworkSecurity`,
`expo-image-picker` with camera permissions, `extra.eas.projectId`).

The backend must be running for login; see `backend/README.md`.

---

## 3. Navigation Model

```
AUTH STACK          Login · Signup · Forgot/Reset Password
     ↓ (authenticated)
MAIN STACK (user)   MAIN_TABS + ACTIVE_WORKOUT (full-screen modal —
                    the ONLY immersive screen; no tab bar during a live workout)
     ↓
BOTTOM TABS (user)  Home · Diet · Workout Routines · Progress · Profile
     ↓ each tab owns a stack containing the shared detail-screen pool
                    (workout detail, routine detail/editor, history, settings,
                     notifications, body, photos, diet trends, build-a-dish,
                     my dishes, health profile, edit profile, …)
                    → the bottom bar + header actions stay visible on every
                      pushed screen (persistent shell)
```

Trainer view (separate shell, blue accent):

```
TRAINER STACK       TRAINER_TABS + trainer detail drills (client detail,
                    assign workout, template editor, plan builders, tags…)
     ↓
BOTTOM TABS (trainer) Clients · Workouts · Recipes · Profile
```

Mode switching: a trainer can run "User View" (own logging) and "Trainer
View" (client management). The switch lives in Profile; the choice persists
via `src/lib/viewMode`.

**Top bar (every screen, from one shared component):**
`src/components/HeaderActions.js` renders 🔔 NotificationBell (unread badge →
NotificationCenter) + ⚙ Settings. Registered via `useHeaderActions(navigation,
deps, extra)`; screens with a contextual action pass it as `extra` (e.g. the
"+" on Recipes/Workouts/My Dishes, Edit/Share on detail screens). Never add a
second header-actions implementation.

Routes: `src/shared/constants/routes.js`. Navigator registration:
`src/navigation/navigators.js`.

---

## 4. Features — Workout Domain

### 4.1 Home
Greeting header, streak summary, active-workout mini-player (persists across
app kills), recent workouts (→ See All → full history), pinned routines,
body-weight quick stats.

### 4.2 Live workout (`WorkoutScreen`, full-screen modal)
- Start empty or from a routine; per-exercise and global rest timers with
  background countdown + local notification; `expo-keep-awake` while active.
- Add exercises (server catalog + custom exercises), sets with weight/reps,
  warm-up sets, superset/circuit groups, per-set type, optional RPE (6–10,
  0.5 steps), plate calculator, per-set previous-performance prefill.
- State lives in `WorkoutContext` (reducer) and is persisted to
  `active_workout` (single-row SQLite) after every mutation.
- Finish → session + exercises + sets written to SQLite → sync queue.

### 4.3 Routines (Workout Routines tab)
Personal workout templates (not date-scheduled): create/edit/delete,
exercises, sets, rest seconds, superset groups, tags, folders, pinned
routines. Trainer-assigned workout plans appear in a separate "From Trainer"
segment (server-truth, read-only).

### 4.4 History
Completed sessions: duration, volume, exercise count; per-set retroactive
type cycling **only inside an explicit Edit mode** (header "Edit" toggle —
view mode is read-only; a stray tap can never mutate a completed workout).
Changing a type recalculates volume/PRs and re-queues sync.

### 4.5 Progress
Per-session and weekly volume charts, consistency heatmap, streaks
(timezone-safe via `src/lib/streakCalc.js`), per-exercise estimated 1RM
(Epley), RPE trend, max weight, PR badges; body metrics (weight +
measurements) and progress photos (compare mode).

### 4.6 Personal records
Automatic PR detection on completed working sets: max weight, est. 1RM, max
volume set, max reps at weight (per unique weight). Toast + haptic on new PR.
Deleting/demoting sets recomputes. Retroactive set-type changes recompute.

### 4.7 Exercise library
Server-authoritative catalog (`GET /exercises/catalog`) synced at login into
local SQLite; custom exercises per user; muscle-group filtering; body-part /
equipment / secondary-muscle metadata.

---

## 5. Features — Diet Domain (log-first)

> **Model**: the daily FOOD LOG is the core entity for every user. Targets
> and structure (trainer plan) are optional overlays. Plan = recommendation,
> Diary = reality, Target = outcome. Plan adherence is never a score.

### 5.1 Diet tab (`features/diet/screens/DietHomeScreen.js`)
- Date navigation (backfill past dates allowed; future dates blocked at the
  data layer — `canLogFoodForDate` — and on the server).
- Summary: logged kcal vs target (plain totals with no bar when no target),
  remaining/over, macro totals, target-source note.
- Meal sections Breakfast/Lunch/Dinner/Snacks — display grouping only.
- Entries: tap to adjust quantity (macros scale proportionally), remove.
- "YOUR TRAINER'S PLAN" card (trainer clients): assigned plan's day-1 meals
  with prescribed amounts, "Assigned by X", View Full Plan → the existing
  read-only plan detail screen (swaps, recipes, notes, allergens). Users
  without a trainer see advisory suggestions instead (dismiss + Settings
  toggle). All three states handled (plan / no plan / no trainer).
- "Find Food To Fit": deterministic suggestion from recents + plan items
  ranked by budget fit and protein.

### 5.2 Add Food (`features/diet/components/FoodSearchModal.js`)
- **Search**: three layers merged server-side — global foods (seeded staples
  + cached Open Food Facts results), personal recipes, trainer catalog,
  custom dishes — with Open Food Facts fall-through that **caches** every
  real match into the shared database (labeled "unverified" until promoted).
- **Barcode**: exact barcode lookup (same caching). Camera scanning is not
  implemented yet — codes are typed/pasted.
- **Recent** (latest quantity per food) — re-logging in one tap.
- **From Trainer** (trainer clients only): items of the ACTIVE assigned plan,
  grouped by the plan's meal structure, logging defaults to the prescribed
  serving; logged copies are snapshots (`food_source_type='trainer_recipe'`,
  `food_source_id` = plan item) — the plan itself is never modified.
- **My Dishes** (custom dishes) and **Manual** entry.
- Allergen warnings: entries checked against the user's intake profile —
  soft confirm, never a hard block.

### 5.3 Custom dish builder (`BuildDishScreen`)
Ingredient-based macro calculator for home-cooked meals: pick ingredients
from the food DB (manual fallback), quantity × unit, macros **snapshotted at
add time**, live whole-dish + per-serving totals. Saved dishes are searchable
and loggable by per-serving values; editing a dish later never changes
already-logged entries.

### 5.4 Targets (optional overlay)
- Sources: **automatic** (calculated from the nutrition profile — see 5.6),
  **self** (user-set), **trainer_override** (trainer-set). The active target
  is a **versioned** row (`user_nutrition_targets`): every change opens a new
  version with `effective_from`; historical days always evaluate against the
  version effective on their date.
- `target_mode`: `daily` or `weekly_average` (rolling 7-day mean vs target —
  flexible days balance out).
- Tolerance ±% (default 10) — inclusive bounds (2400 ±10% → 2160/2640 are on
  target). Calories are the headline; each macro is evaluated independently;
  a macro miss never fails the day.
- Profile changes never overwrite trainer_override/self targets — the new
  recommendation is recomputed and surfaced for review instead.

### 5.5 Structure suggestions
Advisory free-text meal-shape guidance set by the trainer (or self), rendered
as a collapsible "Today's Suggestions" section for non-trainer users and as
part of the trainer-plan overlay otherwise. Never gates anything; Settings →
"Meal suggestions" hides it.

### 5.6 Nutrition profile & automatic calculation
The intake form (Health Profile — Profile tab for clients, onboarding gate
when connecting to a trainer) collects: age, gender, height, weight, target
weight, activity level, primary goal (+ intensity for loss/gain), dietary
pattern, food preferences, avoided foods, allergens, goals, injuries,
medical conditions. `nutritionTargets.js` computes BMR (Mifflin-St Jeor) →
activity factor → goal/intensity adjustment (calorie floors: 1200 F / 1500 M)
→ protein g/kg by goal → fat share → carbs remainder. Incomplete profiles get
no recommendation. The same formula is mirrored server-side
(`backend/src/data/nutritionTargetsCalc.js`) — both are test-asserted
identical.

### 5.7 Trends
7/30-day calorie line chart, averages over **logged days only** (not-logged
days are excluded, never zero-filled), plain-language summaries ("right on
track", "trending low"…), explicit "Not logged: Tue" gaps. Shared
`buildTrendSummary` mirrored in `backend/src/data/nutritionDigest.js`.

---

## 6. Features — Trainer

- **Clients tab**: roster with per-client diet status ("on track / needs
  attention / not enough data"), target + source, pending-sync awareness.
- **Client → Overview**: GitHub-style **activity maps** (12 weeks, scrollable,
  legend + symbols): diet color = nutrition outcome per day (green = calories
  AND configured macros within tolerance, yellow = partial attention, red =
  miss, grey = not logged, in-progress today) evaluated against the target
  version effective on each date; workout map = sessions per day (green) vs
  rest (grey) — plans are templates, so no "missed scheduled workout" is ever
  fabricated. Stat cards on top (week/month on-target, avg calories,
  sessions, streaks), attention lines, tap a day → detail panel → deep-link
  into the Diet/Workouts tab on that exact date.
- **Client → Diet**: trend digest (weekly avg vs target, logged-days counts,
  macro trend notes), day view (status, calories remaining, macro remaining,
  read-only grouped food log, day navigation), week/month history,
  **Adjust Target** (override with optional reason; "Use App Recommendation"
  returns to automatic), structure suggestions editor, per-client
  **missed-target notification toggle** (default OFF; idempotent — one
  notification per client per day per direction; a corrected day never
  re-alerts).
- **Client → Workouts/Supplements**: assigned plan lists, read-only client
  workout summaries + per-set details, strength and volume analytics,
  measurement history, shared progress photos.
- **Notes**: `diet-notes` — lightweight one-way notes with read receipts.
- **Recipes tab**: trainer meal catalog (shared with their clients).

---

## 7. Data & Sync Architecture

```
UI write → SQLite (immediate) → UI re-read → sync queue → POST/DELETE
/user/backup/* → Postgres (idempotent upserts keyed on local ids)
```

- **Queue**: `src/lib/syncEngine.js`. One row per entity+id (dedup while
  pending), payloads rebuilt FRESH from SQLite at process time (never stale),
  dependency ordering (a plan never syncs before its recipes), backoff
  30s→2m→10m→1h (5 attempts; manual retry overrides), deletes are idempotent.
  Modes: auto (foreground/reconnect/10-min) · manual · local-only.
- **Entities**: session, workout_plan, custom_exercise, measurement, recipe,
  diet_plan (+ embedded versions), diet_checkin, diet_swap, diet_food_log
  (legacy plan-scoped), food_log (log-first), custom_dish, supplement_plan,
  supplement_checkin, personal_record, progress_photo.
- **Restore**: on fresh install the restore gate (backup summary counts)
  runs a full ordered pull into SQLite; every read path additionally has a
  lazy hydration safety net (`ensure…Loaded`) that pulls if the local table is
  empty. Restored rows keep their local ids (synced = server truth).
- **Never** call a save endpoint from UI code — write SQLite + enqueue.

## 8. Domain Modules (single source of truth, mirrored mobile ↔ backend)

| Module (mobile, ESM) | Backend mirror (CJS) | Responsibility |
|---|---|---|
| `features/diet/domain/nutritionCore.js` | `backend/src/data/nutritionCore.js` | target status/tolerance, plan follow-through, daily summary, weekly summary, trend language, monitoring exceptions |
| `features/diet/domain/nutritionTargets.js` | `backend/src/data/nutritionTargetsCalc.js` | calorie/macro recommendation, profile validation |
| `features/diet/utils/foodScaling.js` | `nutritionLog.scaleFoodMacros` | per-unit macro scaling (per 100 g/ml vs per piece/spoon) |

Change both sides together — test suites in `test/runTests.js` and
`backend/test/` assert identical behavior on identical scenarios.

## 9. Local Database

`src/db/db.js` owns a numbered migration stack (`PRAGMA user_version`):
`local_recipes`, `local_diet_plans` (+`tracking_mode`, `tolerance_pct`),
plan days/meals/items/alternatives, `local_diet_plan_versions`,
`local_diet_checkins`, `local_diet_item_swaps`, `local_food_log_entries`
(legacy), `food_log_entries` (log-first), `custom_dishes`(+ingredients),
`local_supplement_*`, `exercises`, `workout_plans`, `workout_sessions`,
`session_exercises`, `sets`, `personal_records`, `body_metrics`,
`progress_photos`, `sync_queue`, `sync_cache`, `user_settings`.
Rules: append-only migrations; `ensureSchema` self-heals the baseline; every
table is user-scoped (multi-account devices never leak rows).

## 10. Known Gaps / Roadmap

- Barcode camera scanning (typed codes work today).
- Date-scheduled workout plans (training plans are templates — the workout
  activity map shows sessions, not scheduled-vs-missed).
- Push notification tap-routing for nutrition alerts.
