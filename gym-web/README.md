# Gym Portal (`gym-web`)

The web platform for **Gym Management** — a desktop-first React 18 +
TypeScript + AntD 5 shell with permission-filtered sections, standalone from
both the mobile app and the platform-admin dashboard (`../admin-dashboard`).
It authenticates regular `users` through `/auth` (same accounts as the
mobile app) and speaks to the `/gym` API.

## File map (what lives where)

| File | Contents |
|---|---|
| `src/main.tsx` | AntD `ConfigProvider` (ember primary #E8481F, dark algorithm) + `AntApp` wrapper |
| `src/api/` | THE typed backend client, split per domain. `client.ts`: session token storage/refresh (`/auth/login`, `/auth/signup`, `/auth/refresh`, `/auth/logout`), the `api()` wrapper (Bearer + automatic one-shot refresh on 401 + `X-Gym-Id` selector header) and `API_BASE` (from the root `.env`'s `VITE_API_BASE_URL`). Domain modules: `gyms.ts` (profile, permissions, logo, timezones), `members.ts` (members, app invites, public invitation bridge), `staff.ts` (staff + trainer assignments/roster), `memberships.ts` (plans + membership terms/lifecycle), `billing.ts` (charges/payments/receipts, `formatMoney`), `attendance.ts`, `workouts.ts`, `nutrition.ts`, `assignments.ts` (Phase 13 unified content assignments: assign/list/edit/end with dates, notes, `effective_status`). `index.ts` re-exports everything — the app imports `../api` |
| `src/permissions.tsx` | `GymContext` ({gymId, role, permissions}), `hasPermission(ctx, ...anyOf)` — nav + route guards read this; the data comes from `GET /gym/:id/permissions` |
| `src/App.tsx` | The shell. Order matters: public `/invite/:token` landing page renders FIRST (before auth gating); then boot (session restore → `getMyGyms` → gym select → permissions fetch); then `Layout` with header (gym switcher, account dropdown with `trigger={['click']}`) + Sider (`NAV_ITEMS` filtered by permission) + `Content` routes via `permGuard(perms, node)`. Also: `signedOut` MUST clear the selected gym id (otherwise re-login skips the permission refetch — this was a real bug) |
| `src/pages/LoginPage.tsx` | Sign-in / sign-up tabs (same accounts as the mobile app) |
| `src/pages/InviteLandingPage.tsx` | Public invitation page (works signed-out): dispatches member vs staff invitations (`type` from the API), Create-Account (register-through-invitation), accept-if-email-matches, decline, expired/cancelled/declined/accepted states |
| `src/pages/CreateGymWizard.tsx` | 6-step onboarding (Name → Contact → Address → Hours → Branding → Review); `OperatingHoursEditor` inside |
| `src/pages/Dashboard.tsx` | Landing: profile-completion ring + missing checklist, gym summary, INACTIVE banner with owner reactivation |
| `src/pages/MembersPage.tsx` | Members list (search + membership-status AND app-connection filters + pagination + create drawer). Exports `MemberFormFields`, `memberFormToPayload`, `AppConnectionTag` reused by the detail page |
| `src/pages/MemberDetailPage.tsx` | Member shell: Overview (profile + app-connection card + membership card), then real tabs Membership / Payments / Attendance / Trainer / Workouts / Nutrition; placeholders for Documents / Activity |
| `src/components/MemberMembershipTab.tsx` | Lifecycle UI: Freeze / Resume / Renew / Change Plan / Cancel / Extend + lifecycle timeline |
| `src/components/MemberPaymentsTab.tsx` | Dues + receipts, Record payment, Refund (owner/admin), printable Receipt modal, Add charge |
| `src/components/MemberAttendanceTab.tsx` | ✓/− calendar (21-day strip), QR card (rotatable), mark-present/backdate |
| `src/components/MemberTrainerTab.tsx` / `MemberNutritionTab.tsx` / `MemberWorkoutsTab.tsx` | Assign/change/end assignment UIs per domain |
| `src/pages/StaffPage.tsx` | OWNER: staff table with inline role select, status toggle, add/invite drawer + one-time invite-code modal |
| `src/pages/TrainersPage.tsx` | OWNER: trainers + per-trainer assigned-member counts |
| `src/pages/PlansPage.tsx` / `MembershipsPage.tsx` / `PaymentsPage.tsx` | Billing surfaces (Plans = create/edit/archive with price editor; Memberships = all terms gym-wide; Payments = summary cards + receipt ledger) |
| `src/pages/WorkoutsPage.tsx` / `NutritionPage.tsx` | Gym content: create/edit drawers (exercises-by-name repeater / entries + targets), archive-restore, recommend flag, assigned/saved counts |
| `src/pages/SettingsPage.tsx` | 4 tabs (Profile incl. logo + status lifecycle, Branding, Hours, Contact) |
| `src/pages/PlaceholderPage.tsx` + `components/States.tsx` | `ComingSoon` / `EmptyState` / `ErrorState` (network-aware) / `PermissionDenied` |
| `src/components/DataTable.tsx` + `hooks/usePagedList.ts` | Standard list surface: loading/error-retry/empty/prev-next pagination (fetches pageSize+1 since /gym list APIs return plain arrays without totals; debounced search; `extra` filters re-trigger fetch and reset to page 0) |
| `src/components/FilterBar.tsx`, `PageContainer.tsx`, `StatusBadge.tsx` | Search + up to two selects; breadcrumbs; one place that knows status colors (member/staff/gym/lifecycle incl. FROZEN) |

## Patterns an agent must follow

1. **Permissions**: add the nav entry to `NAV_ITEMS` in `App.tsx` with the
   required permission(s) and wrap the route in `permGuard([...], …)`. The
   backend matrix (`gymPermissions.js`) must actually grant it — nav hiding
   is UX, the backend is the authority.
2. **Data fetching**: use `usePagedList` for any list endpoint (offset
   pagination, no totals); it returns `{rows, loading, error, reload, page,
   hasNext, q, status, extra, setExtra}`. Render through `DataTable`.
3. **Money**: amounts cross the API as integer MINOR units (paise);
   display with `formatMoney(cents, currency)`; inputs are major units ×100
   on submit.
4. **Dates**: pickers submit `YYYY-MM-DD` via `dayjs(...).format()`; never
   `toISOString()` on date-only values.
5. **Logo/images**: the logo endpoint authorizes via Bearer token, so
   render it through `fetchGymLogoBlobUrl` (blob URL), not a plain `src`.
6. **Adding a phase section**: new page in `src/pages`, new typed functions
   in the matching `src/api/<domain>.ts` module (create the module if it
   doesn't exist + re-export from `src/api/index.ts`), nav item + guarded
   route in `App.tsx`, member tab component in `src/components` wired into
   `MemberDetailPage`. Keep placeholders as `ComingSoon` until the backend
   ships — no fake data.

## Run

```bash
npm install
npm run dev        # http://localhost:5174 — proxies /auth and /gym to :4000
npm run build      # tsc -b && vite build
npm test           # vitest unit tests (no backend needed)
npm run lint       # eslint (flat config, prettier-aware)
```

## Configuration (repo root `.env` — no hard-coded URLs)

All configuration is read from the **repo root `.env`** (one file for the
mobile app, the backend and this portal — see `../.env.example`). Copy
`.env.example` to `.env` and adjust:

| Variable | Used by | Meaning |
|---|---|---|
| `GYMWEB_PROXY_TARGET` | `npm run dev` | Where the Vite dev server proxies `/auth` and `/gym`. Default `http://localhost:4000`. Point it at any remote backend, e.g. `https://api.mygym.com`. |
| `VITE_API_BASE_URL` | `npm run build` | Backend origin **baked into the production bundle**. Set it before building to deploy `dist/` as static files against a remote backend (the backend sends permissive CORS). Leave empty for a same-origin deploy behind a reverse proxy. |

```bash
# develop against a remote backend
echo 'GYMWEB_PROXY_TARGET=https://api.mygym.com' >> ../.env && npm run dev

# build for a remote backend deploy
echo 'VITE_API_BASE_URL=https://api.mygym.com' >> ../.env && npm run build
# → upload dist/ anywhere static; all fetches go to https://api.mygym.com
```

The api client resolves every request against `API_BASE`
(`src/api/client.ts`): empty in dev (proxy handles it), the baked-in origin
in production. There are **no** hard-coded `localhost` URLs in `src/`.

## Shell & navigation

Sidebar sections render only when the caller's SERVER-resolved permission
set (GET `/gym/:gymId/permissions`) includes the section's permission:

| Section              | Permission                                                      | Owner | Admin | Trainer | Front desk |
| -------------------- | --------------------------------------------------------------- | ----- | ----- | ------- | ---------- |
| Dashboard            | —                                                              | ✓    | ✓    | ✓      | ✓         |
| Members              | `members.view`                                                | ✓    | ✓    |         | ✓         |
| Memberships          | `memberships.view`                                            | ✓    | ✓    |         | ✓         |
| Payments             | `payments.manage`                                             | ✓    |       |         |            |
| Attendance           | `attendance.manage` / `checkin.manage`                      | ✓    | ✓    |         | ✓         |
| Trainers / Staff     | `staff.manage`                                                | ✓    |       |         |            |
| Workouts / Nutrition | `content.manage` / `workouts.manage` / `nutrition.manage` | ✓    | ✓    | ✓      |            |
| Classes              | `content.manage`                                              | ✓    | ✓    |         |            |
| Communications       | `communications.manage`                                       | ✓    | ✓    |         |            |
| Reports              | `reports.view`                                                | ✓    |       |         |            |
| Settings             | `settings.manage`                                             | ✓    |       |         |            |

Reaching a section's URL without its permission renders a **Permission
denied** page — and the backend rejects the request anyway.

## Routes

`/` (dashboard) · `/members` · `/members/:id` (+ `/membership`,
`/payments`, `/attendance`, `/trainer`, `/workouts`, `/nutrition`,
`/documents` sub-routes) · `/memberships` (+ `/plans`) · `/payments` ·
`/attendance` · `/trainers` · `/staff` · `/workouts` · `/nutrition` ·
`/classes` · `/communications` · `/reports` · `/settings/:tab` ·
`/create-gym` (onboarding wizard) · `/invite/:token` (public invitation
landing, outside the shell).

## What's real vs. placeholder

- **Real**: gym onboarding wizard, profile/settings (incl. logo), members
  list (search by name/email/phone/member ID; independent membership-status
  and app-connection filters; pagination; create drawer), member detail
  (full profile incl. DOB/gender/emergency contact, edit, app-connection
  card with invite / re-invite / withdraw / link / unlink, membership card
  with leave & reactivate, **real Membership tab** with the full lifecycle:
  assign plan / freeze / resume / renew / change plan / cancel / extend,
  plus an append-only lifecycle timeline), **membership plans**
  (create/edit/archive, duplicate-name and validation rules),
  **memberships overview** (all terms gym-wide with search + filters,
  incl. FROZEN), **billing** (see "Billing & payments" below),
  **attendance** (front-desk dashboard: QR scan, search-and-mark,
  today/week/month counts, peak hours, inactive members; member Attendance
  tab with a ✓/− calendar and the member's QR card; owners can backdate
  and delete records), **workouts** (gym-owned content with an ordered
  exercise-by-name editor, versioned originals with
  archive/restore/recommend; member Workouts tab: assign/end with
  history), **nutrition** (gym-owned recipes/meal plans/diet
  recommendations with targets, versioning, archive/restore/recommend;
  member Nutrition tab: assign/end with history), staff
  management (add by email — direct add for existing accounts, one-time
  staff invitation for people without an app account; role change,
  deactivate/reactivate with a reassignment guard), **trainer
  assignments** (member Trainer tab: assign/change/unassign with history;
  Trainers page shows per-trainer assigned-member counts), and the
  trainer's own roster view.
- **Placeholders** (`ComingSoon`): attendance, member sub-tabs
  (attendance/workouts/nutrition/documents/activity), workouts, nutrition,
  classes, communications, reports — their backend phases haven't shipped.
  No fake data, no dead buttons.

## Member state model

Two independent axes (never combined): **membership**
(`ACTIVE/PENDING/FROZEN/EXPIRED/CANCELLED` on `gym_members.status`) and
**app connection** (`CONNECTED` = linked `app_user_id`, `INVITATION_PENDING`
= pending invite, else `NOT_CONNECTED` — derived, never stored as one
column). A member needs no app account at any point; inviting stores only a
SHA-256 hash of the one-time code, and linking consumes the pending invite.
Leaving (cancel) keeps the record, its history and the app link; rejoining
never duplicates users.

## Invitation bridge (public landing page)

`/#/invite/<one-time-code>` renders **outside the shell** for signed-out
visitors: gym name, member name and invited email, with three paths —
**Create Account** (register-through-invitation: the backend creates the
User and links the existing GymMember atomically), **sign in then accept**
(existing accounts; the backend verifies the account email matches the
invited email), and **Decline**. Expired / cancelled / declined /
already-accepted codes render their own honest states; the code is consumed
on acceptance and only its hash is stored server-side.

## UX conventions (reusable components)

`DataTable` (loading/error-with-retry/empty/prev-next pagination), `FilterBar`
(debounced search + status select), `PageContainer` (breadcrumbs), `StatusBadge`,
`EmptyState` / `ErrorState` (network failures detected) / `PermissionDenied` /
`ComingSoon`. List APIs are offset-based without totals — the hook fetches
`pageSize + 1` rows to know when a next page exists.

## Deliberately not here yet

Membership lifecycle, payments, attendance, classes, trainer assignments —
see `../GYM_MANAGEMENT_DESIGN.md` §16 for phasing.

## Billing & payments (Phase 9)

### Where the code lives

| File                                     | Contents                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/billing.ts`                     | `Charge`, `Payment`, `BillingSummary`, `Receipt` types; `getBillingSummary`, `listGymPayments`, `listGymCharges`, `getMemberBilling`, `createCharge`, `recordPayment`, `refundPayment`, `getReceipt`; `formatMoney` (integer paise → ₹ string)                                                               |
| `src/pages/PaymentsPage.tsx`           | `/payments` — four summary cards (Revenue this month / Collected / Due / Overdue) + the receipt ledger (search, method filter, prev/next paging). OWNER/ADMIN only                                                                                                                                                                    |
| `src/components/MemberPaymentsTab.tsx` | The member's Payments tab: dues table with balances, receipts table,**Record payment** modal (charge picker pre-filled with the outstanding balance, amount, method, backdate picker), **Add charge** modal (payments.manage), per-receipt **Receipt** (printable view) and **Refund** (payments.manage) actions |
| `src/pages/MemberDetailPage.tsx`       | Mounts`MemberPaymentsTab` as the member's Payments tab                                                                                                                                                                                                                                                                                 |

### How to use it (portal)

1. **Sell a membership** (Members → member → Membership tab → Assign plan).
   The backend automatically opens a DUE charge for the term's price —
   nothing to enter.
2. **Collect money** (member → Payments tab → Record payment): pick the
   charge (the amount defaults to the outstanding balance), choose the
   method (CASH/UPI/CARD/BANK_TRANSFER/OTHER), optionally backdate. The
   charge flips DUE → PAID (or PARTIAL if partially paid) and a receipt
   number like `RCPT-20260903-F511FB` is issued.
3. **Print a receipt**: Receipt button on any receipt — gym name, member
   (+ "Not connected" tag for non-app members), plan, amount, date, method,
   covered period, receipt number.
4. **Fix mistakes with refunds, never edits** (owner/admin): Refund on a
   receipt, partial or full. Fully refunded receipts read REFUNDED.
5. **Watch the money**: Payments page — revenue this month, collected
   (net of refunds), due and overdue totals.

### Why it is built this way

- **Immutable receipts**: there is no edit/delete path in the UI or the
  API, so a receipt regenerated years later is identical — and a plan price
  change can never rewrite what a member actually paid.
- **Derived status**: DUE/PARTIAL/PAID/OVERDUE are computed from the
  ledger at read time, so the books cannot drift from the data.
- **Non-app members are first-class**: every billing row references the
  gym member, not an app account — Aman with no app pays cash exactly like
  an app-connected member.

## Security model

The portal hides UI by role, but the **backend is the authority**: every
`/gym` request re-resolves the caller's staff/member row and gym-scoped
role from the JWT (`requireGymContext` → `requireGymPermission`). A stolen
gym id, header, or URL grants nothing.
