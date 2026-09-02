# Gym Portal (`gym-web`)

The web platform for **Gym Management** — a desktop-first React 18 +
TypeScript + AntD 5 shell with permission-filtered sections, standalone from
both the mobile app and the platform-admin dashboard (`../admin-dashboard`).
It authenticates regular `users` through `/auth` (same accounts as the
mobile app) and speaks to the `/gym` API.

## Run

```bash
npm install
npm run dev        # http://localhost:5174 — proxies /auth and /gym to :4000
npm run build      # tsc -b && vite build
```

## Shell & navigation

Sidebar sections render only when the caller's SERVER-resolved permission
set (GET `/gym/:gymId/permissions`) includes the section's permission:

| Section | Permission | Owner | Admin | Trainer | Front desk |
|---|---|---|---|---|---|
| Dashboard | — | ✓ | ✓ | ✓ | ✓ |
| Members | `members.view` | ✓ | ✓ | | ✓ |
| Memberships | `memberships.view` | ✓ | ✓ | | ✓ |
| Payments | `payments.manage` | ✓ | | | |
| Attendance | `attendance.manage` / `checkin.manage` | ✓ | ✓ | | ✓ |
| Trainers / Staff | `staff.manage` | ✓ | | | |
| Workouts / Nutrition | `content.manage` / `workouts.manage` / `nutrition.manage` | ✓ | ✓ | ✓ | |
| Classes | `content.manage` | ✓ | ✓ | | |
| Communications | `communications.manage` | ✓ | ✓ | | |
| Reports | `reports.view` | ✓ | | | |
| Settings | `settings.manage` | ✓ | | | |

Reaching a section's URL without its permission renders a **Permission
denied** page — and the backend rejects the request anyway.

## Routes

`/dashboard(/)` · `/members` · `/members/:id` (+ `/membership`,
`/payments`, `/attendance`, `/trainer`, `/documents` sub-routes) ·
`/memberships` (+ `/plans`) · `/payments` · `/attendance` · `/trainers` ·
`/staff` · `/workouts` · `/nutrition` · `/communications` · `/reports` ·
`/settings/:tab` · `/create-gym` (onboarding wizard).

## What's real vs. placeholder

- **Real**: gym onboarding wizard, profile/settings (incl. logo), members
  list (search + status filter + pagination + create drawer), member detail
  (edit, app-account link/unlink), staff management (add by email, role
  change, deactivate/reactivate), trainers list.
- **Placeholders** (`ComingSoon`): memberships & plans, payments,
  attendance, member sub-tabs, workouts, nutrition, classes,
  communications, reports — their backend phases haven't shipped. No fake
  data, no dead buttons.

## UX conventions (reusable components)

`DataTable` (loading/error-with-retry/empty/prev-next pagination), `FilterBar`
(debounced search + status select), `PageContainer` (breadcrumbs), `StatusBadge`,
`EmptyState` / `ErrorState` (network failures detected) / `PermissionDenied` /
`ComingSoon`. List APIs are offset-based without totals — the hook fetches
`pageSize + 1` rows to know when a next page exists.

## Deliberately not here yet

Membership lifecycle, payments, attendance, classes, trainer assignments —
see `../GYM_MANAGEMENT_DESIGN.md` §16 for phasing.

## Security model

The portal hides UI by role, but the **backend is the authority**: every
`/gym` request re-resolves the caller's staff/member row and gym-scoped
role from the JWT (`requireGymContext` → `requireGymPermission`). A stolen
gym id, header, or URL grants nothing.

