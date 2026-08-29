# Modernization Report

**Scope**: full-repo audit + safe modernization. Priority order was: don't break functionality →
keep data/API compatibility → safe upgrades → dead code removal → maintainability.
Baseline was established first (all tests passing) and every step was verified after.

## Verification

```
Mobile unit tests:        PASS (44)
Backend tests:            PASS (56)
Lint:                     PASS (0 errors; pre-existing prettier style warnings remain)
Route registry guard:     PASS
expo-doctor:              PASS (17/17)
Full Metro bundle:        PASS (npx expo export --platform android → 3.96 MB Hermes bundle)
Backend dependency audit: 0 vulnerabilities
```

## Dependency changes

| Package | Change | Reason |
|---|---|---|
| `expo-status-bar` (root) | **removed** | Zero imports anywhere |
| `react-native-reanimated` (root) | **removed** | Zero imports, absent from babel plugins |
| `typescript`, `@types/react` (root) | **removed** | No `.ts` files in the mobile app; they sat in `dependencies` |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (backend) | **installed** (were declared but missing) | `storageService.js` lazily requires them — the S3 path would have crashed at runtime whenever S3 env was configured |
| `nodemailer` (backend) | 9.0.5 → 9.0.6 | Patch |
| `eslint-config-expo` (root, dev) | kept at 57.0.1 + added to `expo.install.exclude` | The SDK-51-expected `~7.1.2` crashes the linter (typescript-estree); the installed version works |

### Deliberate holds (safety over version numbers)

- **Expo SDK 51 → 57 not performed.** It requires React 19 / RN 0.87 / new architecture and a
  native rebuild; it cannot be regression-verified in this environment. All `expo-*` package
  versions already match SDK 51 exactly (`expo install --check` clean).
- **eslint 8 → 9/10, express 4 → 5, bcryptjs 2 → 3, dotenv 16 → 17, admin-dashboard majors
  (antd 6, vite 8, react 19): all held.** Each is a major with migration risk and no
  functional payoff here.
- Mobile `npm audit` reports 32 vulns (1 critical: `tar` chain) — **all inside the Expo 51
  build-time CLI toolchain**, not shipped app code. The only real fix is the SDK upgrade above.
- Backend audit: 0 vulnerabilities.

## Dead code removed

- **Files** (all verified unreferenced): `src/seed/exercises_full.json` (17 MB), `structure.txt`
  (2.4 MB stale tree snapshot), `new_structure.txt`, 10 `.txt` source mirrors
  (`src/lib/{api,tagsApi}.txt`, `src/components/CatalogSearch.txt`, `backend/src/data/*.txt`,
  `backend/src/routes/{client,trainer}.txt`, 2 migration copies), `scripts/post-prebuild.js`
  (superseded by the config plugin).
- **Security-relevant deletions**: `backend/test-{intake,backup,progress-photos,progression}.js`
  contained **hardcoded real credentials committed to git**. They are removed going forward;
  the credentials remain in git history — **rotate that password**.
- **Commented-out legacy code**: 1,026 lines across 16 files (old sync queue implementations in
  `syncEngine.js`/`queries.js`/`sync.js`, the entire legacy server version of
  `MyDishesScreen.js`, old plan-tree writers in `dietPlans.js`, old backup/restore blocks,
  dead screen bodies). Every removed range was assertion-checked to contain only comments
  before deletion. Doc-comment headers were preserved.

## Bug fixes found during the modernization

- `src/lib/restore.js` imported `getAccessToken`/`API_BASE` from `./api`, which **never exported
  them** — the restore path would throw at runtime. Both are now properly exported by `api.js`
  (the access token resolves through the auth hooks, so it stays correct across refreshes).
- `backend/src/admin/auth.js` logged the **plaintext bootstrap admin password** to server logs.
  The password is no longer logged.
- `app.json` and `app.config.js` both existed (expo-doctor failure) — edits to `app.json` were
  silently ignored because `app.config.js` wins. `scheme` was ported into `app.config.js` and
  `app.json` removed; expo-doctor is now 17/17.
- Latent circular dependency `intakeProfiles ↔ nutritionTargetsService` is now lazy-required on
  the one edge that needs it (safe under Node's module cache).

## Refactoring

- Duplicated `macroLine`/`scaled` helpers (plan-detail screen vs `dietPlanUtils`) consolidated
  into `src/features/diet/utils/dietPlanUtils.js` with explicit options (`{ withServing }`,
  `{ round: false }`) preserving each call site's exact behavior.
- Per-request debug logging removed from `src/lib/api.js` / `config.js`; the full cloud-pull
  payload log in `AuthContext` removed. Structured error logging retained.

## Not done (explicitly out of scope, per safety rules)

- Expo SDK major upgrade (see holds).
- Repo-wide prettier formatting (would create a ~3,400-line style-only diff; the pre-existing
  warning level is unchanged and error count is 0).
- admin-dashboard dependency majors (standalone toolchain, untested here).

## Regression checklist status

Verified by test suites and bundle build: auth (token refresh, password reset tests), diet
(plans, swaps, check-ins, food logs, target versioning, tolerance boundaries), trainer
permissions (association guards in route tests), sync (idempotent upserts, dependency ordering —
unit-covered helpers), migrations (backend `node --test` + registry guard). Device-level flows
(login on hardware, offline sync on real network) were **not** exercisable in this environment —
run the app once against the backend before shipping.
