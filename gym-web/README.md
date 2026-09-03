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

`/dashboard(/)` · `/members` · `/members/:id` (+ `/membership`,
`/payments`, `/attendance`, `/trainer`, `/documents` sub-routes) ·
`/memberships` (+ `/plans`) · `/payments` · `/attendance` · `/trainers` ·
`/staff` · `/workouts` · `/nutrition` · `/communications` · `/reports` ·
`/settings/:tab` · `/create-gym` (onboarding wizard).

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
  history), staff
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
| `src/api.ts`                           | `Charge`, `Payment`, `BillingSummary`, `Receipt` types; `getBillingSummary`, `listGymPayments`, `listGymCharges`, `getMemberBilling`, `createCharge`, `recordPayment`, `refundPayment`, `getReceipt`; `formatMoney` (integer paise → ₹ string)                                                               |
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
