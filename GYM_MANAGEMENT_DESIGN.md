# Gym Management System — Phase 0 Technical Design

Status: **DESIGN ONLY — no business functionality implemented.**
Branch: `modernization`. This document is the contract for all subsequent
Gym Management phases. Nothing here modifies existing user/trainer/diet/
workout functionality.

---

## 0. Codebase Analysis (what exists today)

| Area | Current State |
|---|---|
| Mobile app | Expo SDK 51 / RN 0.74, local-first SQLite + sync queue, 5 user tabs (Home · Diet · Workout Routines · Progress · Profile), 4 trainer tabs. Navigation: persistent per-tab stacks (`src/navigation/navigators.js`). |
| Backend | Node/Express + raw `pg` (no ORM), append-only numbered migrations, `registerRoute()` convention with in-app API Explorer, JWT auth (30 m access / 30 d refresh with rotation), `requireAuth` + `requireRole` middleware, `src/data/*` service modules own all SQL. |
| Identity | `users` table: `id UUID, email UNIQUE, password_hash, name, role CHECK IN ('user','trainer')`. Separate `admin_users` for platform staff. `refresh_tokens` table enables revocation. Password reset tokens. |
| Authorization | Role middleware (user/trainer) + relationship guards (`assertActiveAssociation` / `assertReadableAssociation` in `assignedPlans.js`). Admin RBAC by role list. |
| Trainer–client | `trainer_clients` (pending → active → archived(30-day read) → revoked), single active trainer per client, invite codes, per-relationship notification prefs. |
| Diet system | Log-first `food_log_entries` (user+date scoped), global food DB, versioned targets (`user_nutrition_targets`), structure suggestions, diet notes, monitoring/digest services. |
| Workout system | Local-first sessions, server aggregate `session_summaries` (redacted) + full-fidelity `backup_sessions`, templates/assigned plans, progression settings. |
| Notifications | `notifications` table + `push_tokens`, per-relationship `trainer_notifications_enabled`, nutrition `trainer_nutrition_prefs` + idempotent `diet_target_notifications` ledger. |
| File uploads | `storageService.js`: S3 with local `uploads/` fallback; dish photos (`/uploads/dish-photo`), progress photos (first-class `/progress-photos` with storage keys). |
| PDF generation | **None exists anywhere.** If gym receipts/invoices need PDFs, that is a new capability (recommend `pdfkit` server-side or client-side generation). |
| Web | `admin-dashboard/` — React 18 + Vite + TypeScript + Ant Design 5 + react-router-dom 6, own package.json/lockfile, LoginPage + RBAC pages (Users, Relationships, Content, Nutrition, Analytics, Audit, Database, Flags, Sync Health, API Explorer, Broadcast), typed `api.ts` client, impersonation support. **No gym functionality.** |
| Validation/error | Backend: `HttpError(status, message)` pattern, `httpError(res, e)` responder, route-level validation in data modules. Mobile: local-first writes never blocked by network; API errors surface via Alert. |
| Testing | Backend: `node --test` (63 tests). Mobile: plain-Node pure-logic tests (44). No web tests. |
| Multi-tenant isolation pattern (existing) | Per-relationship predicate filters in every query (`trainer_id`/`plan_server_id`) — the gym system should follow the same convention, scaled to `gym_id`. |

### What does NOT exist yet (all net-new)

Gyms, gym members, staff, memberships, payments, attendance, gym-level
trainer assignments, classes/bookings, announcements, documents, audit log,
any gym web portal. **Nothing in the current schema references a gym.**

---

## 1. Architecture Diagram

```
                        ┌──────────────────────────────┐
                        │        SHARED BACKEND        │
                        │   Node/Express · Postgres    │
                        │  /auth /client /trainer      │
                        │  /user/backup  /admin        │
                        │  /gym   ← new surface        │
                        └───────┬──────────────┬───────┘
                                │              │
              ┌─────────────────┘              └──────────────────┐
              │                                                   │
   ┌──────────▼─────────┐                            ┌────────────▼──────────┐
   │  MOBILE APP (RN)   │                            │  GYM WEB PORTAL (new) │
   │  existing 5 tabs   │                            │  Vite+React+TS+AntD   │
   │  + later "My Gym"  │                            │  gym owner/staff/desk │
   └────────────────────┘                            └───────────────────────┘

IDENTITY (separate concepts — never merged):

  users (global app identity)          gyms (tenant)
    │ role: user | trainer |              │
    │ gym_staff (after migration)         │
    │                                      │
    │        ┌─────────────────────────────┤
    │        │                             │
    ▼        ▼                             ▼
  GymStaff (staff login via user)   GymMember (appUserId NULL allowed)
    gym_role: OWNER/MANAGER/           │
    FRONT_DESK/TRAINER                 ├── Membership → MembershipPlan
                                       ├── Payment
    TrainerAssignment (gym-scoped)     ├── Attendance
    GymAssignment (workout/nutrition)  ├── Document
                                       └── Booking (Phase 3)
```

**Critical structural rule (per spec):** `users.role` gains a `gym_staff`
value only so staff can authenticate to the web portal. The gym
relationship itself lives in `gyms` → `gym_staff` / `gym_member`, never on
the user row. `User.gymId` is forbidden.

---

## 2. Entity Model & Relationships

### 2.1 Core identity separation

| Concept | Table | Meaning |
|---|---|---|
| Global user identity | `users` | Can log into the mobile app. Zero or more gyms. Unchanged except the role CHECK widening. |
| Gym (tenant) | `gyms` | The tenant root. Every gym-scoped row carries `gym_id`. |
| Gym membership of a PERSON | `gym_members` | One row per person per gym. May exist with **no** app account (`app_user_id NULL`). |
| Gym staff role | `gym_staff` | One row per staff user per gym (`gym_role`). A user can staff multiple gyms. |
| Trainer–client relationship (existing) | `trainer_clients` | Global, gym-independent personal-training relationship. **Never** replaced by `TrainerAssignment` — they coexist (see §2.4). |

### 2.2 Entity-by-entity (with phase)

**Phase 1 — foundation**

| Entity | Table | Key columns | Relationships |
|---|---|---|---|
| Gym | `gyms` | id, name, slug UNIQUE, timezone, currency(3), status(ACTIVE/SUSPENDED), address fields, settings JSONB | tenant root |
| GymStaff | `gym_staff` | id, gym_id→gyms, user_id→users (nullable in theory, NOT NULL in practice for P1), gym_role(OWNER/MANAGER/FRONT_DESK/TRAINER), status, UNIQUE(gym_id,user_id) | who may operate the portal |
| GymMember | `gym_members` | id, gym_id→gyms, member_code UNIQUE per gym (human key, e.g. GYM-000123), first/last name, email, phone, app_user_id→users NULL, status(PENDING/ACTIVE/FROZEN/EXPIRED/CANCELLED), joined_at, notes | the person-in-gym record |
| MembershipPlan | `membership_plans` | id, gym_id, name, billing_period(DAILY/MONTHLY/QUARTERLY/SEMIANNUAL/ANNUAL), price_cents, currency, duration_days, classes_included INT NULL, is_active, soft-delete | what can be purchased |
| Membership | `memberships` | id, gym_id, gym_member_id, plan_id, status(ACTIVE/EXPIRED/FROZEN/CANCELLED/PENDING_PAYMENT), starts_on, ends_on, UNIQUE(gym_member_id, starts_on) partial | one active membership per member (enforced partially: UNIQUE WHERE status=ACTIVE) |
| Payment | `payments` | id, gym_id, gym_member_id, membership_id NULL (walk-ins/fees), amount_cents, currency, method(CASH/CARD/UPI/TRANSFER/OTHER), status(PAID/PENDING/REFUNDED/FAILED), paid_at, reference, notes, created_by→users | financial record; NEVER deleted — refunds are new rows/updates |
| Attendance | `attendance` | id, gym_id, gym_member_id, check_in_at, check_out_at NULL, method(DESK/QR), created_by | multi-row per day allowed (in/out), indexed (gym_id, check_in_at) |
| TrainerAssignment | `gym_trainer_assignments` | id, gym_id, gym_member_id, trainer_user_id→users(role trainer), starts_on, ends_on NULL, status | gym-scoped coaching; distinct from `trainer_clients` |
| AuditLog | `audit_logs` | id, gym_id, actor_user_id NULL, actor_label (for pre-link actions), action, entity, entity_id, before JSONB, after JSONB, ip, created_at | append-only, no UPDATE/DELETE grants |

**Phase 2 — coaching & content**

| Entity | Table | Notes |
|---|---|---|
| GymWorkout / GymNutrition | `gym_workout_templates`, `gym_nutrition_plans` | gym-scoped content libraries the gym's trainers author (mirror the existing assigned-plan tree shapes) |
| GymAssignment | `gym_assignments` | gym_trainer_assignments → member, content_type(WORKOUT/NUTRITION), content_id, assigned_by, status — the gym analogue of assigned plans |

**Phase 3 — operations**

| Entity | Table | Notes |
|---|---|---|
| Branch | `branches` | gym_id → optional sub-locations; Phase-3 tables get branch_id NULLable (single-branch gyms leave NULL) |
| Class | `gym_classes` | name, branch_id, trainer_user_id, capacity, schedule rows |
| Booking | `gym_class_bookings` | class_session_id, gym_member_id, status, UNIQUE(class_session_id, member) |
| Announcement | `gym_announcements` | gym_id (→branch), title/body, audience(MEMBERS/STAFF/ALL), published_at |
| Document | `gym_documents` | gym_id, gym_member_id NULL, storage_key, kind(CONTRACT/ID/FORM), uploaded_by |
| GymRole | lookup/enum | `gym_role` TEXT on gym_staff backed by a seeded `gym_roles` lookup table (OWNER, MANAGER, FRONT_DESK, TRAINER, MEMBER) — extensible without migrations for new roles |

### 2.3 Relationship rules

1. `gym_members.app_user_id` is **NULLable FK, partial-unique** — one app
   account can be linked to at most one membership **per gym**, but one user
   can be a member of many gyms.
2. Linking an existing member to an app account happens by **verified email
   match** (the member's email must equal the user's email) and is an
   explicit staff action → sets `app_user_id`, writes an audit row. No
   second member row, no duplicate user.
3. Payments/Attendance/Memberships reference **`gym_member_id`, never
   `user_id`** — non-app members have full financial/attendance history.
4. `gym_trainer_assignments` is orthogonal to `trainer_clients`:
   - `trainer_clients` = personal training between two app users (existing).
   - `gym_trainer_assignments` = "Rohit coaches member X at ABC Fitness",
     valid even when X has no app account.
5. Deleting: members/payments/attendance use soft-delete or status only;
   audit rows are immutable.

---

## 3. Database Strategy

- Shared Postgres, **additive migrations numbered 043+** in
  `backend/migrations/`. No edits to existing migrations; no destructive
  DDL; no column added to `users` except the role CHECK widening
  (`'user','trainer'` → + `'gym_staff'`) which is additive.
- All new tables: `gym_id UUID NOT NULL REFERENCES gyms(id)` (except `gyms`
  and lookups), `created_at/updated_at` with the existing
  `set_updated_at()` trigger pattern, soft-delete via status columns.
- Money: **integer cents** + `currency CHAR(3)` — never floats.
- Multi-tenancy: **shared-schema row scoping** (same pattern as the existing
  trainer visibility predicates): every gym query takes `gym_id` from the
  authenticated staff identity, enforced in `src/data/gym*.js` service
  modules — never trusted from the client. Postgres RLS is a future
  hardening option, not a Phase 1 dependency.
- Indexes: `(gym_id, status)`, `(gym_id, member_code)`,
  `(gym_member_id, log_date)` on attendance, `(gym_id, paid_at)` on
  payments, `(app_user_id)` on gym_members for app linking.

---

## 4. Authentication Architecture

| Actor | Authenticates as | Surface |
|---|---|---|
| Standalone app user | existing `users` row (role `user`) | mobile app |
| Trainer (personal) | existing `users` row (role `trainer`) | mobile app |
| Gym owner/staff | `users` row with role `gym_staff` + `gym_staff` row in ≥1 gym | **Gym Web Portal** |
| Gym member without app account | no login at all | front desk only |
| Connected gym member | existing `users` row (role `user`) | mobile app |
| Platform admin | `admin_users` (unchanged) | admin dashboard |

- Reuse the existing JWT pair (30 m access / 30 d refresh), `bcryptjs`,
  refresh-token revocation — **zero new auth code paths**.
- New role value `gym_staff` is added to the `users.role` CHECK by an
  additive migration. Gym creation seeds `gym_staff (gym_role='OWNER')` for
  the creating user inside one transaction.
- Login response already returns `user.role`; the web portal redirects
  non-`gym_staff` users away. Per-gym context: staff of multiple gyms get a
  gym picker; the chosen `gym_id` is sent as an `X-Gym-Id` header and
  re-verified against `gym_staff` on every request (defense in depth).

---

## 5. Authorization Model

```
gym_role matrix (web portal):

  ACTION                    OWNER  MANAGER  FRONT_DESK  TRAINER
  manage gym settings         Y      Y         N          N
  manage staff                Y      Y         N          N
  manage members              Y      Y         Y          N
  view members                Y      Y         Y          Y (assigned only)
  manage plans/memberships    Y      Y         Y(sell)    N
  record payments             Y      Y         Y          N
  record attendance           Y      Y         Y          N
  assign workouts/nutrition   Y      Y         N          Y (assigned members)
  view audit log              Y      Y         N          N
  announcements               Y      Y         Y(draft)   N
```

- Enforcement: `requireRole('gym_staff')` + `requireGymRole(action)` in
  `src/middleware/gymAuth.js` — the middleware loads the caller's
  `gym_staff` row for `X-Gym-Id` and checks the matrix. Centralized, not
  per-route scattered.
- Platform admins (`admin_users`) keep their separate surface; a gym owner
  is **not** a platform admin.
- Mobile member authorization: a connected member sees only data joined
  through their `gym_member.app_user_id = users.id` rows.

---

## 6. Gym Member Lifecycle

```
 prospective ──staff creates──▶ PENDING_PAYMENT ──payment PAID──▶ ACTIVE
 ACTIVE ──expiry date passes──▶ EXPIRED (job or lazy evaluation)
 ACTIVE ──staff freeze──▶ FROZEN ──unfreeze──▶ ACTIVE (ends_on extended by freeze days)
 any ──member cancels / staff cancels──▶ CANCELLED (history retained)
 EXPIRED ──renewal payment──▶ ACTIVE (new Membership row, old row kept)
```

- Expiry is evaluated **lazily** on read (plus an optional daily job later) —
  no cron dependency in Phase 1.
- Every transition writes `audit_logs` and (when the member is app-linked) a
  notification row.
- Member lifecycle is fully valid for non-app members: staff create the
  member, sell a membership, take payments, record attendance — no user row
  ever required.

---

## 7. App Account Linking

```
GymMember (app_user_id NULL, email = x@y.com)
      │  person installs app + signs up with x@y.com
      ▼
users row exists (role user)
      │  staff opens member → "Link app account" (email search)
      ▼  validates: no other gym_members row in this gym already linked
GymMember.app_user_id = users.id   (UPDATE, never INSERT)
      │  + audit log + notification
      ▼
member now sees "My Gym" (membership status, payments, attendance) on mobile
```

- Reverse unlink is a staff action (keeps history, nulls the link).
- Search matches by exact email only (no fuzzy PII exposure).
- If the person has never signed up, staff can send an invite (existing
  push/email infra, Phase 2).

---

## 8. Web Application Architecture (Gym Portal)

**Recommendation: a new standalone app `gym-web/`** — Vite + React 18 +
TypeScript + Ant Design 5 + react-router-dom 6, mirroring the proven
`admin-dashboard` structure (typed `api.ts`, per-module pages, login + RBAC
guard), but a separate build/deployment and a separate auth surface.

Why not extend `admin-dashboard`: the admin app's entire authorization model
is *platform staff over all tenants*; injecting tenant-scoped gym owners
into it would cross the platform-admin trust boundary and complicate its
RBAC. A sibling app reuses the patterns (copy-adapt, not shared code) while
keeping trust domains separate.

```
gym-web/
  src/api/            typed fetch client (JWT + X-Gym-Id header)
  src/auth/           login, session, role context
  src/pages/          Dashboard · Members · MemberDetail · Plans ·
                      Memberships · Payments · Attendance · Staff ·
                      TrainerAssignments · Classes · Announcements ·
                      Documents · AuditLog · Settings
  src/components/     MemberPicker, MoneyText, StatusTag, ConfirmDialog
  routing             react-router; role-guarded routes per the §5 matrix
```

---

## 9. React Native Integration Architecture

**Phase 1: mobile app unchanged** (spec: standalone users keep working).

**Phase 2 (member-facing)**: a "My Gym" section inside the Profile tab (or a
6th surface) for app-linked members, read-mostly:
- membership status + expiry, payment history, attendance history
- gym announcements
- assigned gym workouts/nutrition (Phase 2 content)

All via new `GET /gym/my/*` endpoints that resolve the caller's
`gym_members` rows by `app_user_id` — no sync-queue involvement (gym data is
server-authoritative and online-viewed; local caching only if UX requires).

**Trainer-side**: gym trainers keep using the existing mobile trainer
surfaces for coaching; gym-scoped assignment happens on the web portal.

---

## 10. API Structure (`/gym` surface, routes/gym.js + src/data/gym*.js)

```
# gyms & staff
POST   /gym                                create gym (seeds OWNER staff)
GET    /gym/mine                           gyms the caller staffs
POST   /gym/:gymId/staff                   add staff (role)
GET    /gym/:gymId/staff
# members
POST   /gym/:gymId/members                 create (app_user_id NULL by default)
GET    /gym/:gymId/members?status=&q=&cursor=
GET    /gym/:gymId/members/:memberId
PATCH  /gym/:gymId/members/:memberId       status/name/contact changes
POST   /gym/:gymId/members/:memberId/link-app    { user_id | email }
POST   /gym/:gymId/members/:memberId/unlink-app
# plans & memberships
CRUD   /gym/:gymId/plans
POST   /gym/:gymId/members/:memberId/memberships     sell/renew
POST   /gym/:gymId/memberships/:id/freeze | unfreeze | cancel
# payments & attendance
POST   /gym/:gymId/payments                record payment (may activate membership)
GET    /gym/:gymId/payments?member=&from=&to=
POST   /gym/:gymId/attendance/check-in     { member_id } (desk)
POST   /gym/:gymId/attendance/:id/check-out
GET    /gym/:gymId/attendance?date=&member=
# trainer assignments & content (Phase 2)
CRUD   /gym/:gymId/trainer-assignments
CRUD   /gym/:gymId/workout-templates | nutrition-plans | assignments
# operations (Phase 3)
CRUD   /gym/:gymId/classes + bookings | announcements | documents | branches
GET    /gym/:gymId/audit-log
# mobile (member-facing, Phase 2; role user)
GET    /gym/my/memberships | payments | attendance | announcements
```

Conventions: same `registerRoute()` + `HttpError` + `requireRole` patterns
as the rest of the backend; `X-Gym-Id` + `requireGymRole` for all gym-scoped
routes; cursor pagination on list endpoints.

---

## 11. Validation, Error Handling, Audit

- **Validation**: in data modules (existing pattern) — statuses checked
  against enums, money as positive integer cents, date order (starts_on ≤
  ends_on), email format only when linking. The web portal adds AntD form
  rules client-side but the backend is the authority.
- **Errors**: existing `HttpError` + `httpError(res, e)` responder; web
  client maps status codes to AntD messages.
- **Audit**: one write helper `gymAudit(gymId, actor, action, entity, id,
  before, after)` called inside the same transaction as every mutation of
  members/memberships/payments/staff. Actors: `user_id` when linked, else
  `actor_label` ("front-desk: Priya"). Audit rows are append-only.

---

## 12. Notifications, Files, Multi-Branch

- **Notifications**: reuse the `notifications` + `push_tokens` tables with a
  new `type` per event (membership_activated, payment_recorded,
  class_booked, announcement_published). Only app-linked members receive
  push; non-app members get nothing (front desk informs them).
- **Files**: `storageService.js` (S3/local) under a per-gym key prefix
  `gyms/<gym_id>/…`; `gym_documents.storage_key` follows the existing
  progress-photo pattern.
- **Multi-branch (future)**: Phase 1 gyms are single-location
  (`branches` deferred). The schema keeps branch columns NULLable on Phase-3
  tables so multi-branch is additive: add `branches`, add optional
  `branch_id` to attendance/classes/documents, and a staff branch-scope
  column — no rewrites of Phase 1 tables.

---

## 13. Migration Plan (additive, ordered)

| # | Migration | Contents |
|---|---|---|
| 043 | `gym_core` | `gyms`, `gym_roles` lookup seed, `gym_staff`, `gym_members`; `users.role` CHECK widened + `gym_staff`; audit_logs |
| 044 | `gym_billing` | `membership_plans`, `memberships`, `payments` |
| 045 | `gym_operations` | `attendance`, `gym_trainer_assignments`, `gym_documents` |
| 046 | `gym_content` | `gym_workout_templates`, `gym_nutrition_plans`, `gym_assignments` |
| 047 | `gym_ops2` | `branches`, `gym_classes`(+sessions), `gym_class_bookings`, `gym_announcements` |

Each migration is idempotent (`IF NOT EXISTS`), additive, and ships with
tests. No backfill is needed (new domain, no legacy rows). Rollback = drop
the new tables (they reference nothing existing except `users`).

---

## 14. Testing Strategy

- **Backend** (`node --test`, matching the existing suite): membership
  lifecycle state machine (pay→activate→expire→freeze), payment
  cents/currency integrity, attendance multiple-per-day, linking rules
  (duplicate prevention, email match, multi-gym), gym-role authorization
  matrix (every role × every action), tenant isolation (staff of gym A can
  never read gym B — the critical test), audit rows written transactionally.
- **Web portal**: Vitest for money/date formatting and the role-guard
  routing logic; Playwright smoke later (login → member → sell membership).
- **Mobile**: existing 44 tests untouched; new pure-logic tests for
  membership-status display mapping when Phase 2 lands.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Tenant leakage (gym A sees gym B) — the #1 risk of multi-tenant | every query takes gym_id from verified staff identity; dedicated isolation tests; no gym_id from client bodies |
| Duplicating users as members on app signup | linking is an explicit staff action with verified-email match + uniqueness constraints |
| Money bugs (floats, currency mixing) | integer cents + currency on every row; no conversion without explicit rate |
| Auth sprawl (second login system for staff) | staff authenticate as `users` with role `gym_staff`; no new credential store |
| Scope creep into the mobile app before the portal exists | Phase 1 is portal-only; mobile integration is Phase 2 |
| Overloading `trainer_clients` semantics | gym assignments are a separate table; the two coexist by design |
| Audit gaps for pre-link (non-app) actions | `actor_label` supports staff-recorded actions on behalf of non-app members |
| PDF receipts expectations | no PDF infra exists — either defer receipts to "payment record" UX or add `pdfkit` as an explicit Phase 2 task |

---

## 16. Recommended Implementation Order

1. **Phase 1a — Foundation**: migrations 043–044, `/gym` auth + role
   middleware, gyms + staff + members CRUD, `gym-web` scaffold (login,
   members list/detail, member creation).
2. **Phase 1b — Billing & attendance**: plans, memberships (lifecycle),
   payments, attendance, audit log, dashboard stat cards.
3. **Phase 1c — Hardening**: isolation test suite, role matrix tests,
   audit coverage review.
4. **Phase 2 — Coaching & member app**: trainer assignments, gym
   workout/nutrition content + assignments, app linking UX, mobile "My Gym"
   section, notifications.
5. **Phase 3 — Operations**: branches, classes/bookings, announcements,
   documents, PDF receipts (if required).

Each phase ships independently usable value; phases 1a–1c alone deliver a
working gym front desk.
