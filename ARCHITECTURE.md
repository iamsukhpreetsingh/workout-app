# Architecture Overview

A map for new developers: where to find things, and how the pieces fit.

## Repos in this workspace

| Path | What it is |
|---|---|
| `/` (root) | Expo (SDK 51) React Native mobile app — the product |
| `backend/` | Node/Express + PostgreSQL API (port 4000) |
| `admin-dashboard/` | Standalone React + Vite + Ant Design admin console (own toolchain/lockfile) |

## Mobile app (`src/`)

```
src/
  features/diet/          Diet feature: domain math, AddFoodModal, plan builder UI
    domain/               nutritionCore.js  — ONE authoritative status/tolerance/follow-through/
                          monitoring calculator (mirrored in backend/src/data/nutritionCore.js)
                          nutritionTargets.js — ONE calorie/macro recommendation calculator
                          (mirrored in backend/src/data/nutritionTargetsCalc.js)
  features/workouts/      Workout feature components/screens
  features/coaching/      Trainer-side components
  db/                     Local-first SQLite layer (expo-sqlite). db.js owns the numbered
                          migration stack (PRAGMA user_version). One module per entity
                          (dietPlans.js, foodLog.js, dietSwaps.js, recipes.js, …)
  lib/                    Cross-feature infrastructure:
                          api.js (fetch wrapper + auth hooks), syncEngine.js (THE upload
                          queue: fresh payloads, dependency ordering, backoff, idempotent
                          deletes), checkinDates.js (timezone-safe date helpers),
                          allergens.js, restore.js, trainerCache.js
  store/                  React context (auth, app/theme state)
  navigation/             Navigator registration; route names in shared/constants/routes.js
  screens/                Feature screens (naming: <Thing>Screen.js)
  components/             Shared UI components
  theme.js                Design tokens: useColors() live palette + spacing scale
```

## Backend (`backend/src/`)

```
server.js                  Express bootstrap; mounts routers from src/routes/*
routes/                    client.js / trainer.js (role-guarded) · backup.js (offline sync
                           upserts under /user/backup/*) · auth, admin, etc. All routes
                           register via registerRoute() so the admin API explorer sees them
data/                      One service module per domain:
                           coachingPlans.js (diet/supplement plan trees) · foodLog.js (food
                           diary backup) · nutritionTargetsService.js (active target
                           versioning + trainer override rules) · nutritionMonitoring.js
                           (exception-first trainer alerts) · nutritionCore.js +
                           nutritionTargetsCalc.js (calculator mirrors — keep behaviorally
                           identical to the mobile copies) · backup.js, mealCatalog.js,
                           trainerClients.js, intakeProfiles.js, dietNotes.js, storageService.js
middleware/auth.js         JWT auth + role guard
admin/                     Admin API + dashboard support
migrations/                Numbered SQL migrations (npm run migrate). Append-only — never edit
                           an applied migration
```

## Key invariants (do not break)

- **Offline-first**: every mobile write goes to SQLite first, then the sync queue
  (`src/lib/syncEngine.js`) pushes to `/user/backup/*` with idempotent upserts keyed on
  client-generated local IDs. Never call save endpoints directly from UI code.
- **One calculator per rule**: target status/tolerance/monitoring (nutritionCore) and
  calorie recommendations (nutritionTargets) each exist as a mobile ESM + backend CJS mirror.
  Both copies are covered by test suites asserting identical scenarios — change them together.
- **Targets are versioned** (`user_nutrition_targets`, backend migration 039): target changes
  open new versions with `effective_from`; historical food diaries always evaluate against the
  version in force on their date. Trainer overrides are never silently overwritten.
- **Local SQLite migrations**: append a new numbered async function to `MIGRATIONS` in
  `src/db/db.js`. They run once per device; `ensureSchema` self-heals the baseline.
- **Permissions**: trainer visibility is always scoped to trainer-ASSIGNED plans
  (`plan_server_id` / `trainer_id` filters). Self-authored client plans and diaries are private.

## Commands

```bash
# mobile
npm test                 # pure-logic unit tests (plain Node)
npm run lint             # eslint (prettier warnings are pre-existing noise; 0 errors required)

# backend
cd backend
npm run migrate          # apply SQL migrations
npm test                 # node --test suite (includes auth, admin, nutrition)
npm run check-routes     # route-registry guard (runs automatically in npm run dev)

# full-app bundle verification (catches broken imports without a device)
npx expo export --platform android --output-dir /tmp/bundle-check
```

## Environment

- Mobile: `.env` in root read by `app.config.js` (`USE_LOCAL`, `API_URL_LOCAL`,
  `API_URL_REMOTE`). `app.config.js` is the single live config — there is no `app.json`.
- Backend: `backend/.env` (`DATABASE_URL`, `JWT_SECRET`, `SMTP_*`, optional S3 vars for
  `storageService.js`; without them it falls back to local disk uploads).
