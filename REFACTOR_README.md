# Refactor Guide — Structural Cleanup & Bug Fixes

**Scope:** Expo mobile app only (`App.js` + `src/`). `backend/` and `admin-dashboard/` untouched.
**Constraints honored throughout:** zero functional regression, zero visual regression, JavaScript only (no TS migration), no new runtime dependencies (dev-only tooling added with approval).

---

## 1. Why this refactor exists

The codebase had: monolithic screens (up to 1,328 lines) mixing data fetching, business logic and UI; four near-identical list implementations; ~65 hardcoded navigation strings; 20 screens talking directly to SQLite modules; zero error boundaries and seven screens with unhandled async failures; copy-pasted utilities that had already drifted (a wrong kg→lb conversion shipped to production); no lint/format tooling; ~700 lines of commented-out dead code.

The refactor introduced a feature-based structure while preserving every screen's behavior. All changes were verified after each module with unit tests (`node test/runTests.js`), ESLint, and a full Metro bundle compile.

---

## 2. New folder structure

```
src/
  features/
    workouts/                 # active-workout logging
      screens/WorkoutScreen.js
      components/             # WorkoutTopBar, SetRow, ExerciseNotesEditor,
                              # SuggestionBanner, SwapSheet
      utils/                  # workoutMath.js (volume/set math, RPE options),
                              # workoutUtils.js (duration/superset labels)
    routines/                 # plans / templates
      components/             # PlanCard (+ PinButton/PlanEmptyState/NewPlanButton),
                              # ExerciseEditRow
    diet/
      components/DietDayCard.js
      utils/dietPlanUtils.js  # MEAL_TYPES, id gen, macro formatting
    coaching/                 # trainer-side client management
      components/             # OverviewPanel, ClientWorkoutsTab,
                              # CoachingList, Segmented
      utils/clientAnalytics.js# duration/relative-time/volume-bucket helpers
  services/                   # storage facade — the ONLY place that may import src/db/*
    workoutService.js         # sessions, progress, PRs
    routineService.js         # plan CRUD
    bodyService.js            # body metrics + progress photos
    settingsService.js        # user settings
    dietService.js            # recipes + diet plans + supplement lists
  shared/
    components/LoadError.js   # load-failure fallback (icon/message/retry)
    constants/routes.js       # ALL route names — single source of truth
    hooks/useAsyncData.js     # {data, loading, error, reload} fetch hook
    utils/format.js           # fmtDate, fmtShortDate, fmtVolume
    utils/units.js            # kg<->lb (2.20462), weight format/parse
  navigation/
    navigators.js             # all five navigators extracted from App.js
  theme.js                    # unchanged palettes + new spacing scale tokens
```

**Import aliases** configured in `babel.config.js` (`@features`, `@shared`, `@services`, `@store`, `@lib`, `@db`, `@components`, `@screens`, `@theme`, `@navigation`) for use in new code; existing relative imports were left alone to keep diffs reviewable.

---

## 3. Tooling added (Phase 0)

| Item         | File(s)                              | Notes                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint       | `.eslintrc.js`                     | `eslint-config-expo` + Prettier. New react-hooks v7 advisory rules (`set-state-in-effect`, `refs`, `purity`, `static-components`) downgraded to **warnings** — they flag many existing intentional patterns, tracked for future cleanup |
| Prettier     | `.prettierrc`, `.prettierignore` | 100 cols, single quotes.**Not mass-applied** (~2,800 warnings remain) to keep this refactor reviewable — run `npm run format:write` as a dedicated standalone commit when ready                                                                 |
| Path aliases | `babel.config.js`                  | See above                                                                                                                                                                                                                                                |
| Scripts      | `package.json`                     | `npm run lint`, `npm run format`, `npm run format:write`                                                                                                                                                                                           |

New devDependencies (dev-only): `eslint`, `eslint-config-expo`, `eslint-config-prettier`, `eslint-plugin-prettier`, `prettier`, `babel-plugin-module-resolver`.

---

## 4. Screen-by-screen changes

### App.js (547 → ~330 lines)

- All navigator definitions moved to `src/navigation/navigators.js`; screen registrations now use route constants.
- Intake gate no longer fabricates a `{route, navigation}` object — `IntakeFormScreen` gained optional explicit `gate`/`onClose` props (stack usage via React Navigation unchanged).
- Deleted commented-out sync effect and duplicate imports.

### WorkoutScreen (1,094 lines → 839-line container + 5 components)

- Moved to `features/workouts/screens/`. Presentational pieces extracted: `WorkoutTopBar`, `SetRow`, `ExerciseNotesEditor`, `SuggestionBanner`, `SwapSheet`.
- Pure logic extracted: `workoutMath.js` (done-sets count, volume sum, clock format, set-has-values) and `workoutUtils.js`.
- PR evaluation, save/discard flows, suggestion loading remain in the container.
- Verified via dispatch-action audit (every reducer action count matches old+new) and a stylesheet key diff (**identical**).
- `elapsedSeconds`/`formatDuration`/`groupLabels` moved out of `store/WorkoutContext` into `workoutUtils`; the context **re-exports them**, so existing imports (e.g. HistoryScreen) still work.

### PlansScreen (1,109 → ~745 lines)

- Deleted two fully-commented old list components (~230 lines).
- Four near-clone lists (`MyRoutinesList`, `AssignedList`, `DietPlansList`, `SupplementPlansList`) now render through one shared `PlanCard` component. Every per-list quirk preserved: assigned cards' accent bar + missing icon tile, icon size differences in empty states (38 vs 40), tag-preference order differences between diet and supplement plans, pin source strings, nav targets/params.
- Removed redundant parent-level state that fetched `listPlans()` and `/client/assigned-plans` on every focus but whose results were never read (each list fetches its own).

### PlanEditorScreen (492 → 414)

- Per-exercise row extracted to `ExerciseEditRow`; stepper clamping unified and proven equivalent; db imports switched to `routineService`/`settingsService`.

### ClientDetailScreen (1,328 → ~840)

- Pure helpers → `coaching/utils/clientAnalytics.js`.
- UI blocks → `OverviewPanel`, `ClientWorkoutsTab`, `CoachingList`, `Segmented`.
- ~90 lines of commented dead code removed (old progression-override implementations etc.). API-call audit confirmed live endpoints unchanged.
- **Bug fix:** the client notification preference was fetched twice per focus (two competing focus effects both calling `/trainer/clients`). Merged into a single loader.

### DietPlanBuilderScreen (778 → ~685)

- Day cards → `diet/components/DietDayCard.js`; pure helpers (`MEAL_TYPES`, key generation, macro line formatting) → `diet/utils/dietPlanUtils.js`.
- DB imports switched to new `services/dietService.js`.
- Removed duplicated commented field mappings and a dead `findMeal` helper.

### Other touched files

- **HeaderActions.js:** fixed conditional hook call (`navOverride || useNavigation()`) — hook now always called; behavior identical.
- **HistoryScreen:** adopted `useAsyncData` (focus-driven via `reload`); same empty/error rendering.
- **ProgressScreen / BodyScreen / PlanDetailScreen / ExerciseProgressScreen / SessionDetailScreen:** wrapped previously-uncaught load effects with try/catch + shared `LoadError` fallback (only shown when there is no stale data). ViewChoiceScreen was audited — it has no async calls.
- **17 files:** all hardcoded `navigate('...')` strings replaced with `shared/constants/routes.js` constants, including dynamic dispatch sites (config objects in ClientDetailScreen, ternary picks in PlansScreen, nested-tab `screen:` params, ActiveWorkoutMiniBar route comparisons).
- **theme.js:** date/volume formatters moved out to `shared/utils/format.js`; added `spacing` scale export (no visual change).
- **ClientDietPlanDetailScreen:** removed shadowed duplicate StyleSheet keys (the later definitions already won at runtime).
- **lib/units.js deleted** (was entirely unused); superseded by `shared/utils/units.js`.

---

## 5. Bug fixes included (user-approved)

| # | Bug                                                                                                                                                              | Fix                                                                                                                          | User-visible effect                                |
| - | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1 | kg→lb conversions used`2.205` instead of `2.20462` in BodyScreen (×3) and ProgressScreen (×1)                                                             | All sites use shared`kgToLb`/`lbToKg`                                                                                    | Displayed lb values shift by ~0.05% (now correct)  |
| 2 | `DELETE FROM workout_plans WHERE user_id IS NULL OR ''` ran on **every launch**, silently destroying any row that ever got written without a `user_id` | Removed from`ensureSchema`; such rows are inert (all readers filter by `user_id`). One-time v20/v21 migrations untouched | Plans can no longer be silently deleted at startup |
| 3 | Exercise seed loop ran unconditionally on every cold start                                                                                                       | Now runs only when the library is incomplete; still self-heals fresh/broken installs                                         | Faster cold start on healthy installs              |
| 4 | App.js rendered`IntakeFormScreen` with a hand-built fake `{route, navigation}`                                                                               | Screen accepts explicit`gate`/`onClose` props in overlay mode                                                            | None (brittleness removed)                         |
| 5 | Seven screens made DB/API calls with zero catch handlers                                                                                                         | try/catch +`LoadError` fallback with Retry                                                                                 | Graceful failure instead of silent hang/crash      |
| 6 | Conditional hook call in HeaderActions                                                                                                                           | Hook always called                                                                                                           | None (latent crash risk removed)                   |
| 7 | Duplicate StyleSheet keys in ClientDietPlanDetailScreen                                                                                                          | Shadowed earlier keys removed                                                                                                | None (later keys already won)                      |
| 8 | Duplicate`/trainer/clients` fetch per focus in ClientDetailScreen                                                                                              | Merged into one loader                                                                                                       | Half the roster requests on that screen            |
| 9 | PlansScreen refetched local plans + assigned plans every focus into state that was never read                                                                    | Dead state/effects removed                                                                                                   | Two fewer redundant fetches per focus              |

---

## 6. Known issues logged but NOT fixed

1. **Startup SQL deletes user-less sessions/plans inside v20/v21 one-time migrations** — historical semantics kept intentionally (they already ran on existing installs).
2. **`loadNotificationPref` fetches the whole trainer roster** to find one client's flag — needs a dedicated endpoint (backend change, out of scope).
3. **~2,800 Prettier warnings** across the repo — apply via `npm run format:write` as its own commit (mechanical, no behavior change).
4. **Advisory react-hooks warnings** (`set-state-in-effect`, `refs`, `purity`, `static-components`) — real cleanup candidates, downgraded to warnings during this pass.
5. A few components rebuild their style object inside the render body (e.g. ProgressScreen, PRToast) — cosmetic perf nit, listed for a future pass.
6. Hardcoded hex colors remain in CalendarHeatmap/PRToast/PlateSheet — should migrate to theme tokens eventually.

---

## 7. Verification performed after every module

- `node test/runTests.js` — 28/28 passing (plate math, e1RM/RPE stats, positional prefill, progression formulas, check-in dates)
- `npx eslint .` — **0 errors** at every step (warnings tracked above)
- `npx expo export --platform android --dev` — full bundle compiles (validates all imports resolve through Babel config)

---

## 8. Recommended manual regression pass (full app)

1. Auth → login/signup → view choice (trainer) → switch views
2. Home: streak, pinned routines, session cards, header actions
3. Workout logging end-to-end (see checklist in phase notes): sets, RPE, PRs, supersets, swaps, notes, rest timer restore, finish/save flows
4. Routines tab: all four lists, pins, search across plan types, create/edit routine incl. supersets & alternatives
5. Body: weight log kg↔lb round-trip, progress photos
6. Progress & History: charts, ranges, drill-downs
7. Diet: builder days/meals/items/alternatives, dish picker, My Dishes CRUD, check-ins
8. Trainer: clients list, client detail tabs (all five), assign flows, tags, notifications deep links
9. Settings/Sync: mode switching, logout, intake gate on fresh trainer link

---

## 9. Conventions going forward

- Route names: always import from `@shared/constants/routes`
- Storage: never import `src/db/*` from UI code — go through `src/services/*`
- Shared UI/logic: `@shared/*`; feature-specific: `features/<name>/{screens,components,hooks,services}`
- Presentational components take data + callbacks via props; containers own state/effects
- Future recommendation: TypeScript migration (types for route params would eliminate the dynamic-dispatch risk noted in the audit) — deliberately not done here
