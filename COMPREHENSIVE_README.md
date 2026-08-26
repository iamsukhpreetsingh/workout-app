# Workout Tracker — Comprehensive Guide

A three-part fitness platform:

1. **Mobile app** (Expo / React Native) — an offline-first workout logger used by both regular users and trainers.
2. **Backend API** (Node.js + Express + PostgreSQL) — accounts, trainer–client coaching, sync/backup, notifications.
3. **Admin dashboard** (React + TypeScript + Ant Design) — internal ops: users, analytics, broadcasts, moderation.

Everything below explains what each feature is, how it works under the hood, and how **users** vs **trainers** interact with it.

---

## Table of Contents

- [Architecture & Tech Stack](#architecture--tech-stack)
- [Roles](#roles)
- [Accounts, Login & Signup](#accounts-login--signup)
- [User View Features](#user-view-features)
  - [Home](#home)
  - [Live Workout Session](#live-workout-session)
  - [Routines (Plans)](#routines-plans)
  - [Pinned Routines](#pinned-routines)
  - [History](#history)
  - [Progress Tracking](#progress-tracking)
  - [Exercise Library](#exercise-library)
  - [Set Types](#set-types)
  - [RPE (Rate of Perceived Exertion)](#rpe-rate-of-perceived-exertion)
  - [Rest Timer](#rest-timer)
  - [Supersets & Circuits](#supersets--circuits)
  - [Plate Calculator](#plate-calculator)
  - [Personal Records (PRs)](#personal-records-prs)
  - [Progression Formulas](#progression-formulas)
  - [Exercise Alternatives & Mid-Session Swaps](#exercise-alternatives--mid-session-swaps)
  - [Body Metrics](#body-metrics)
  - [Progress Photos](#progress-photos)
  - [Diet Plans & Nutrition](#diet-plans--nutrition)
  - [My Dishes (Personal Recipes)](#my-dishes-personal-recipes)
  - [Supplement Plans](#supplement-plans)
  - ["From Your Trainer" (Coaching)](#from-your-trainer-coaching)
  - [Health Intake Profile](#health-intake-profile)
  - [Notifications](#notifications)
  - [Settings](#settings)
- [Trainer View Features](#trainer-view-features)
  - [View Switching (Dual Mode)](#view-switching-dual-mode)
  - [Clients Tab](#clients-tab)
  - [Invite Codes & Client Linking](#invite-codes--client-linking)
  - [Client Detail (5-Tab Shell)](#client-detail-5-tab-shell)
  - [Workout Templates & Assignment](#workout-templates--assignment)
  - [Assigning Diet Plans](#assigning-diet-plans)
  - [Assigning Supplement Plans](#assigning-supplement-plans)
  - [Meal Catalog (Recipes Tab)](#meal-catalog-recipes-tab)
  - [Tags](#tags)
  - [Per-Client Progression Overrides](#per-client-progression-overrides)
  - [Unlinking & Archive/Purge Lifecycle](#unlinking--archivepurge-lifecycle)
  - [Reactivation (Restore History vs Start Fresh)](#reactivation-restore-history-vs-start-fresh)
- [Privacy Model (What the Trainer Can See)](#privacy-model-what-the-trainer-can-see)
- [Offline-First Design & Sync](#offline-first-design--sync)
- [Admin Dashboard](#admin-dashboard)
- [Getting Started (Local Setup)](#getting-started-local-setup)
- [Running Tests](#running-tests)

---

## Architecture & Tech Stack

| Layer | Stack | Location |
|---|---|---|
| Mobile app | Expo SDK 51, React Native 0.74, React Navigation, expo-sqlite, expo-notifications, expo-secure-store, react-native-svg | repo root |
| Backend | Node.js, Express 4, PostgreSQL via raw `pg` pool, JWT + bcrypt auth | `backend/` |
| Admin dashboard | Vite 5, React 18, TypeScript, Ant Design 5, Recharts | `admin-dashboard/` |

**Core design principle — offline-first:** the mobile app's local SQLite database is the source of truth for all workout data. The backend receives *redacted* summaries for trainers and *full-fidelity backups* for cloud restore, but the app works fully without network.

**Key directories:**

- `src/screens/` — all mobile screens
- `src/db/` — local SQLite data-access layer
- `src/lib/syncEngine.js` — unified background sync engine
- `src/store/` — React Context state (Auth, App settings, Workout session, Notifications)
- `backend/src/routes/` — REST endpoints (`auth`, `client`, `trainer`, `backup`, `notifications`, `progression`)
- `backend/migrations/` — numbered SQL migrations (30 total)
- `admin-dashboard/src/pages/` — admin pages

---

## Roles

There are two in-app roles chosen at signup, plus a separate admin system:

| Role | What they get |
|---|---|
| **user** | The standard experience: log workouts, routines, progress, body metrics, photos, self-authored diet/supplement plans, My Dishes. Can connect to *one* trainer via invite code. |
| **trainer** | Everything a user has, **plus** a dedicated Trainer View: client roster, workout templates, meal catalog, plan assignment, client analytics. Trainers can switch between User View and Trainer View freely. |
| **admin** | Entirely separate (`admin_users` table). Only accessible from the admin dashboard. App users can never reach `/admin/*` and vice versa. |

Enforcement:

- Signup sends `role` → stored on `users.role`.
- Backend middleware `requireAuth` + `requireRole('trainer')` guards every trainer endpoint.
- JWTs carry `{ id, role }`; access tokens last 30 min, refresh tokens 30 days with rotation and server-side revocation.
- Admin impersonation of users issues **read-only** tokens — every mutating verb is blocked server-side.

---

## Accounts, Login & Signup

**How users interact:**

1. Launch → splash screen while tokens restore from secure storage.
2. If not logged in → Login or Signup.
3. Signup asks for name, email, password (≥8 chars), and a role choice: **"I'm a User"** or **"I'm a Trainer"**.

**How it works:**

- Passwords hashed with bcrypt (cost 11).
- Access token (30 min) + rotating refresh token (30 days) stored server-side so logout revokes it.
- The API wrapper (`src/lib/api.js`) attaches the token and performs exactly one silent refresh on 401 before forcing logout.
- No demo accounts exist — everyone signs up fresh.
- There is no unauthenticated path; the whole app is login-gated.

---

## User View Features

Users get four bottom tabs: **Home · History · Routines · Progress**, plus stack screens for detail/editing/settings.

### Home

**What it is:** the launchpad — streak counter, quick-start button, pinned routines strip, recent workouts, and trainer-assigned content.

**How users use it:**

- Tap **Start Workout** → choose "Start Empty Workout" or pick a routine → drops straight into the live logging view.
- Tap any card in **Recent Workouts** to open its full session detail.
- Tap a **pinned routine** to start that workout directly (no intermediate screen).
- The **"From Your Trainer"** section appears only when a trainer has assigned plans (see [From Your Trainer](#from-your-trainer-coaching)).
- Settings gear lives in the Home header only.

### Live Workout Session

**What it is:** the heart of the app — real-time exercise/set logging during a workout.

**How users use it:**

- Start empty or from a routine/pinned card/assigned trainer plan.
- Add exercises from the searchable library; sets prefill with your **previous performance** (matched per-set-position — set N shows your last session's set N weight×reps as placeholders; tap the LAST cell to quick-fill).
- Enter weight + reps per set, tap done. Warm-up/drop/failure types selectable per set.
- Rename the workout by tapping its name (empty-started ones default to smart names like "Wednesday Workout").
- Finish → choose "One-time Only" or "Save as Routine" (empty-started workouts); routine-started ones keep their original flow.
- Discard or restart (restart clears logged sets/timer but keeps the exercise list, with confirmation).

**How it works:**

- **Persistent mini-bar** (`ActiveWorkoutMiniBar`) floats over every screen while a workout is active: name, live elapsed time, completed-set count, inline pause/resume. Tapping expands the full-screen logging modal.
- **Crash/kill recovery**: the entire active workout serializes into the `active_workout` table on every change and restores on relaunch — kill the app mid-set and everything (including pause state) comes back.
- Screen sleep is prevented during active workouts only (`expo-keep-awake`).
- **Volume math rule**: only completed working/drop/failure sets count toward volume, PRs, streaks — placeholders and warm-ups never do. Un-marking a set removes it from the live total instantly.

### Routines (Plans)

**What it is:** reusable personal workout templates.

**How users use them:**

- Create a routine with target sets/reps, per-exercise rest times, supersets, notes.
- One-tap start from the routine card.
- Pin favorites (see below), edit, delete, share (text export of structure only — never RPE/notes/dates).
- Client-role accounts see two sub-tabs here: **My Routines** and **From Trainer**, plus a **Workouts | Diet** dock for diet plans.

### Pinned Routines

- Up to **6 pins** across both self-made and trainer-assigned routines combined (cap enforced with an alert, not silent failure).
- Pins render as a horizontal strip on Home; tapping starts the workout directly; long-press offers Unpin.
- Stale pins (deleted routine, archived/revoked trainer plan) are silently cleaned on every Home load.

### History

- Chronological sessions list with duration, exercise count, volume.
- PR badges 🏆 on record-setting sets.
- Full session detail: tap any set row to retroactively change its type (this re-queues the session for re-sync).
- Color coding: sessions started from a trainer-assigned plan show a blue stripe + "Trainer" label (never color alone — always an icon too).
- Delete sessions; share icon exports structure-only text.

### Progress Tracking

**How users use it:**

- Per-session volume charts (Trend line / Per Session bars / By Muscle Group views).
- GitHub-style consistency heatmap shaded by daily volume.
- Streaks (current + longest), timezone-aware, with configurable rest-day tolerance.
- Weekly stats cards.
- Per-exercise deep dive: estimated 1RM (Epley) trend chart, RPE trend with auto-generated insights ("your RPE is climbing at this weight — ready to progress" or "load reduction suggested"), max weight, total volume, per-session history.

**How it works:** all aggregates exclude warm-up and not-completed sets, computed locally via SQL over SQLite.

### Exercise Library

- **39 seeded exercises** across Chest, Back, Legs, Shoulders, Arms, Core, Cardio, Other (seeded on first launch if the table is empty).
- Custom exercise creation; searchable + muscle-group filterable picker shared everywhere exercises are added.
- Muscle groups rendered as custom SVG glyphs.

### Set Types

Every set carries a type:

| Type | Label | Counted in volume/PRs? |
|---|---|---|
| Working | W | Yes |
| Warm-up | WU | **No** — excluded from volume, 1RM, PRs; visually de-emphasized |
| Drop set | DS | Yes, flagged in history |
| Failure | F | Yes, flagged in history |

Tap a set row in session detail to cycle its type retroactively.

### RPE (Rate of Perceived Exertion)

- Optional chips (6–10 in 0.5 steps) appear after marking a set complete.
- Fully optional; toggleable off entirely in Settings.
- Feeds the per-exercise RPE trend chart and progression insights.

### Rest Timer

- Auto-starts after completing a set (per-exercise rest time overrides global default, default 90s).
- Persistent pill bar with countdown, −15s/+15s adjust, skip.
- Backgrounded timers schedule a local notification (expo-notifications).
- End timestamp persists, so even a cold relaunch restores a running timer.

### Supersets & Circuits

- Link 2+ exercises into a group in the routine editor or mid-workout.
- Visual bracket connectors + group labels (Superset A, B…), optional "rest after full round" toggle per group.
- Unlink individual exercises; deleting one member of a 2-exercise group auto-clears the sibling.

### Plate Calculator

- Bottom sheet on each set's weight input showing per-side plate breakdown.
- Greedy largest-first algorithm with remainder reporting; independent kg/lb handling.
- Bar weight and plate inventory configurable in Settings.

### Personal Records (PRs)

Automatic detection across four record types: **max weight**, **max reps at weight**, **max volume set**, **estimated 1RM (Epley)**.

- Celebrated with an animated toast + haptic feedback on completion.
- Badges shown in history.
- Backfilled from existing data; demotes to next-best automatically when a PR-holding set is deleted.

### Progression Formulas

Suggestion engine that tells you what to lift next:

| Formula | Behavior |
|---|---|
| Linear | Add fixed increment when all target reps hit |
| Double Progression | Stay at weight until top of rep range, then increase |
| RPE-Autoregulated | Adjust based on reported RPE |
| Percentage-Based | Work off a percentage of estimated 1RM |

**How it works:**

- Calculation always happens **on-device** (`src/progressionFormulas/`).
- Multi-weight safety: sets are grouped by distinct weight; only the TOP weight group drives suggestions (never a lighter ramp set), warm-ups excluded.
- Resolution precedence: **active trainer override → user's own setting → app default** (linear).
- Suggestions appear as banners inside the workout screen.
- Configure yours in Settings; trainers can override per-client (see below).

### Exercise Alternatives & Mid-Session Swaps

- A routine/template/assigned-plan exercise can carry up to 3 configured alternatives ("if bench is taken, do incline DB press").
- During a live session, open the swap sheet to switch to an alternative **for this session only** (the underlying plan is untouched).
- Ad-hoc swaps to any library exercise also allowed; swapped rows show provenance (`originally: X`).

### Body Metrics

- Log weight plus waist/chest/hips/arms/thighs/neck/body-fat %.
- Trend charts over time; backdate entries via date picker.
- Syncs to the server so trainers can view measurements.

### Progress Photos

- Capture via camera or library; grid view grouped by date; full-size viewer; select any two for side-by-side comparison.
- Stored locally first; backed up to server storage under `uploads/progress-photos/<user_id>/`.

### Diet Plans & Nutrition

Structured nutrition programming: **plan → days → meal slots → items**.

**How users use them:**

- Open **Routines → Diet** tab. Two kinds appear:
  - **Self-authored plans** — build your own with "+ New Diet Plan", using My Dishes + custom items (no trainer needed). Edit/delete your own plans freely.
  - **Trainer-assigned plans** — read-only, listed under From Trainer.
- Day tabs (hidden for single "Every Day" plans), expandable item cards revealing full macros, serving size, recipe link, and notes.
- Running day totals vs macro targets with progress bar (scoped strictly to the visible day — no cross-day bleeding).
- **Daily check-in**: two tappable cards — "Followed it" / "Not today"; long-press adds an optional note. Check-ins feed the trainer's adherence view.

**How it works:**

- Plan items are **snapshots** — editing a dish later never changes existing plans.
- Items support quantity multipliers (e.g., 1.5× serving scales macros proportionally) and per-item notes.
- Date-scoped swaps let you substitute items on specific dates.
- Allergen conflict warnings fire against your intake profile where relevant.

### My Dishes (Personal Recipes)

- Your own dish catalog (name, description, calories/macros, serving size, recipe URL, photo, ingredients, allergens, prep/cook time, difficulty, suggested meal slots, tags, alternate servings).
- Searchable + tag-filterable; used by your own diet-plan builder's picker.
- When adding a custom item on the fly: "Save Dish" persists it AND attaches, or "Use Once — Don't Save".
- Photos upload via base64 to the backend.

### Supplement Plans

Flat plans (name, dosage, timing, notes per item) with daily check-ins — mirrors the diet model exactly. Self-authored or trainer-assigned, checked in the same way.

### "From Your Trainer" (Coaching)

When connected to a trainer who assigned content:

- Home shows assigned workout plans (blue accent + coach icon + "Assigned by [Name] · N exercises"), refreshed on every focus.
- Assigned plan detail is read-only with full structure (sets/reps, rest chips, supersets, trainer notes) and a **Start Workout** CTA — starting resolves plain-text exercise names to your local library (auto-creating custom entries when missing) and runs the identical live-session flow.
- Trainer-assigned diet/supplement plans surface through the Routines screen's Diet tab with check-ins.
- Disconnect anytime via Settings → "Disconnect from Trainer" (explicit confirmation: trainer content goes, your own history stays).

### Health Intake Profile

- Clients with an active trainer and no completed profile hit a **non-dismissible gate** on launch: allergens, goals, injuries, medical conditions.
- Powers automatic allergen-conflict warnings on assigned diet plans and gives trainers safe context.
- Editable later via Profile → Health Profile.

### Notifications

In-app notification center (bell icon with unread count):

| Type | Trigger |
|---|---|
| `workout_assigned` | Trainer assigns you a workout plan |
| `diet_assigned` | Trainer assigns a diet plan |
| `supplement_assigned` | Trainer assigns a supplement plan |
| `workout_completed` | Trainer notified when you finish a workout |
| `diet_checkin` / `supplement_checkin` | Trainer notified of your daily check-in |

Read/dismiss/mark-all-read actions; Expo push tokens registered for push delivery; per-client trainer-notification preference controls which events reach the trainer.

### Settings

Units (kg/lb), default rest seconds, RPE toggle, bar weight, plate inventory, streak tolerance, account (logout), trainer connection card, health profile, Data & Sync (sync mode, backup status), progression formula, and — for trainers — the view switcher.

---

## Trainer View Features

### View Switching (Dual Mode)

Trainers are also gym-goers, so they get **both** experiences:

- On login, a **View Choice screen** presents two large cards: **Trainer View** (blue accent) / **User View**.
- The choice persists in secure storage; restarts mount straight into it.
- "Switch to User View" / "Switch to Trainer View" buttons exist in both Settings screens. Plain users never see any switch UI.
- Logging out clears the choice; next login asks again.

Trainer View tabs: **Clients · Workouts · Recipes · Settings** (blue active tab color).

### Clients Tab

The roster:

- Active clients with **adherence %** and relative last-active ("2 days ago").
- Pending section with Accept/Reject (optimistic updates rolled back on failure).
- Archived section with "Archived · N days left" countdowns; archived clients open read-only with an amber banner and disabled assign buttons.
- Persistent share icon in the header opens the invite-code modal at any time.

### Invite Codes & Client Linking

**How trainers use it:** generate a single-use code (8-char hex, 7-day expiry), share it via the OS share sheet.

**How clients use it:** Profile → Trainer card → enter code → preview screen showing trainer identity (+ reconnection info if applicable) → send request → trainer accepts.

Rules enforced server-side:

- Codes are atomically claimed — single-use.
- One active relationship per client; duplicate requests are idempotent.
- Invite codes are never trusted to resolve identity client-side — the server resolves the trainer from the code.

### Client Detail (5-Tab Shell)

Tapping a client opens a tabbed shell — Overview / Analytics / Workouts / Diet / Supplements:

- **Overview**: week/month stat cards (workout count + volume), Quick Actions row (Assign Workout / Diet / Supplement), merged recent activity feed.
- **Analytics**: Volume / Strength / Measurements tabs with Week/Month/Custom range control:
  - Strength = Epley e1RM trend per exercise (computed in SQL server-side).
  - Volume by session, by date range, and by muscle group (with "Untagged" bucket).
  - Measurements mirrored from the client's body logs.
- **Workouts**: accordion list of recent synced sessions — expand for per-set drill-down (structural only) — plus Assigned list and Assign Workout.
- **Diet / Supplements**: assigned plan lists with builders, plan detail showing a **4-week adherence strip** (grey = no check-in recorded, never implied "missed").

### Workout Templates & Assignment

**Templates** (Workouts tab): the trainer's reusable workout library — searchable, tag-chipped, built with the same builder UI as routines (superset linking, set/rest steppers).

**Assignment flow** — two-tab picker:

- **From Saved**: pick a template → **Assign As-Is** (one tap) or **Edit** (prefills a copy — the saved template is never touched).
- **Build New**: from-scratch builder with optional "Also save this as a reusable template" checkbox (off by default).

Snapshot semantics: assigning copies the template server-side; editing/deleting the template afterwards never changes past assignments.

Assigned plans can be **archived** from the client's Assigned list (confirm dialog; row kept in Postgres, removed from the client's active lists).

### Assigning Diet Plans

Built with `DietPlanBuilderScreen`:

- Plan name/notes, optional daily macro/calorie targets.
- Collapsible editable days ("Day 1" / weekday names / "Every Day").
- Meal-slot sections; add items **From Catalog** (searchable, snapshotted) or **Custom Item** (quick-entry with optional "save to catalog too").
- Per-item quantity multiplier steppers and inline client-specific notes.
- Empty-catalog escape hatch: create a new dish inside the picker without losing your place in the plan.

Client receives a notification, sees the plan read-only under Routines → Diet → From Trainer, and checks in daily.

### Assigning Supplement Plans

Same builder pattern, supplement fields (name/dosage/timing/notes). Same snapshot, check-in, and archive semantics.

### Meal Catalog (Recipes Tab)

First-class trainer tab:

- Reusable dish library with full CRUD, photos, macros, tags, allergens, difficulty, recipe links, favorite flag, alternate servings.
- Shared search tooling (`CatalogSearch`: text + tag chips) reused by Recipes tab, workout templates, and diet builder pickers.
- Editing a catalog dish never affects already-assigned plans (snapshots).

### Tags

- Two categories: **workout** tags (Push, Pull, Legs…) and **recipe** tags (Vegetarian, Keto…).
- Defaults auto-seeded on trainer signup; fully manageable CRUD in Tag Manager.
- Used for filtering across templates and recipes.

### Per-Client Progression Overrides

Trainers can override a specific client's progression formula (e.g., force Double Progression for a beginner) from the client context. Server stores the override; resolution precedence is trainer override → user setting → default; calculation still runs on-device.

### Unlinking & Archive/Purge Lifecycle

Either party can end the relationship:

1. Relationship flips to `archived` with `purge_at = now + 30 days`.
2. Trainer keeps **read-only** access to synced history; client loses all trainer content **immediately** (no restart needed).
3. After 30 days, the purge job (`npm run purge-archives`, cron daily at 03:00) hard-deletes **only trainer-owned content** (assigned plans, trainer-created diet/supplement plans) — never the client's own sessions, measurements, or self-authored plans — then flips the row to terminal `revoked`.

Pending reactivation requests are explicitly skipped by the purge job, even past their original purge date.

### Reactivation (Restore History vs Start Fresh)

If a client re-submits a trainer's invite code after archiving:

- Client sees a **"Reconnect?"** sheet: archived date, remaining plan counts, and a choice — **Restore History** or **Start Fresh** — with a note that the trainer confirms first.
- Trainer's pending card flags "↻ Reconnecting · archived N days ago" with Restore History / Start Fresh buttons:
  - **Restore**: same row revived — all history reappears for both sides instantly (nothing was deleted).
  - **Fresh**: original archived row stays on its untouched countdown; a clean new relationship starts separately.
- Declining a reactivation returns to `archived` with the countdown preserved (ordinary requests reject to `revoked`).

---

## Privacy Model (What the Trainer Can See)

This is a deliberate architectural boundary:

| Data | Trainer sees? |
|---|---|
| Session aggregates (duration, volume, set counts) | ✅ |
| Per-set drill-down (weight × reps × type × completion, structure only) | ✅ |
| Measurements/body metrics | ✅ |
| e1RM strength trends, volume by muscle group | ✅ |
| Check-ins, adherence | ✅ |
| **RPE values** | ❌ never leave the device |
| **Personal/per-exercise notes** | ❌ never leave the device |
| **Shared note** (client-authored, explicit) | ✅ the one deliberate exception |

Two parallel server schemas enforce this: redacted tables (`session_summaries`, `session_exercise_details`) for trainer-facing analytics, and separate `backup_*` tables holding full fidelity for the owner's cloud restore only. The trainer-facing payload physically cannot include RPE/private notes.

---

## Offline-First Design & Sync

**Local SQLite is truth.** Every write goes to SQLite first, then a unified sync engine (`src/lib/syncEngine.js`) enqueues it.

- **Sync modes**: Auto (default), Manual, Local-only. Local-only mode shows a periodic reminder (every 14 days) about backup risk.
- **Retry backoff**: 30s → 2m → 10m → 1h (max 5 attempts), dependency ordering guarantees parent rows sync before children.
- **Triggers**: app foreground, network reconnect, and a 10-minute interval.
- **Full-fidelity backup**: complete sessions (including RPE and notes), plans, recipes, diet/supplement plans, measurements, PRs, and progress photos replicate to `backup_*` tables keyed by `(user_id, local_entity_id)` — powering **restore-on-login**: a fresh install detects missing local data and offers a full cloud restore overlay.
- **Idempotency**: upserts on stable keys mean force-quitting mid-sync loses nothing and duplicates nothing.

---

## Admin Dashboard

Separate web app (`http://localhost:5173`, proxies `/admin/*` to the backend on :4000). Admin roles: `super_admin`, `support`, `content_moderator`, `analyst`, `read_only` — menu visibility gated per role.

| Page | Capabilities |
|---|---|
| **Overview** | DAU/WAU/MAU, signup trends, cohort retention |
| **Database** | Generic table browser/editor across all Postgres tables |
| **API Explorer** | Auto-discovered route registry (all admin routes register themselves) |
| **Users** | Search, suspend (blocks app login), force-logout, role change (refused while trainer still has clients) |
| **Content** | Reports queue, platform-wide content deletion, cross-table tag merge |
| **Health** | Sync-queue health monitoring, archive purge status + manual trigger |
| **Broadcast** | Audience preview + mass push/in-app notifications |
| **Flags** | Feature flags with rollout percentage (polled by the app at launch) |
| **Audit** | Immutable log of every admin write |

Bootstrap super admin is created on first backend start: `admin@workout.local` / `ChangeMe123!` (override via env vars — **change these immediately**).

---

## Getting Started (Local Setup)

### Prerequisites

Node.js ≥ 18, npm, PostgreSQL 14+, and Expo Go (or iOS/Android simulators) for the mobile app.

### Environment

Copy `.env.example` → `.env` at the repo root. Both backend and app config read from it:

```bash
USE_LOCAL=true
API_URL_LOCAL=http://<your-LAN-ip>:4000   # physical device needs LAN IP
API_URL_REMOTE=https://your-deployment    # optional
DATABASE_URL=postgresql://user:pass@localhost:5432/workout_tracker
JWT_SECRET=<random-string>
PORT=4000
ADMIN_JWT_SECRET=<random-string>
ADMIN_BOOTSTRAP_EMAIL=admin@workout.local
ADMIN_BOOTSTRAP_PASSWORD=<change-me>
```

Cloud-hosted Postgres (Supabase/Railway/Neon): set `DATABASE_URL` and `PGSSL=true`.

### 1. Backend

```bash
cd backend
npm install
npm run migrate     # versioned migrations — safe to re-run
npm run dev         # http://localhost:4000
```

Note: the dev server does not hot-reload; restart after backend file changes (`npx nodemon server.js` avoids this). Optional cron job: `npm run purge-archives` for expired archives.

### 2. Mobile app

```bash
npm install
npx expo start      # scan QR with Expo Go, or press i / a
```

Other scripts: `npm run android`, `npm run ios`, `npm run lint`, `npm test`.

### 3. Admin dashboard

```bash
cd admin-dashboard
npm install
npm run dev         # http://localhost:5173
```

Log in with the bootstrap admin credentials above.

---

## Running Tests

```bash
npm test            # pure-Node unit tests (repo root)
```

Covers: plate calculator math, Epley e1RM, NULL-safe RPE averaging, RPE insight generation, positional previous-performance prefill, linear progression suggestion rules, warm-up exclusion from aggregates.

Additional self-checks: `src/progressionFormulas/selftest.mjs` (formula registry), ad-hoc backend scripts (`test-backup.js`, `test-intake.js`, `test-progression.js`).

---

*For deeper implementation details, see `docs/` (screens, db schema, backend, components) and `backend/README.md`. This document describes current behavior; `README.md` contains historical development notes.*
