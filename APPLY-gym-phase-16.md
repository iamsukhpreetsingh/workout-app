# gym-phase-16-multi-branch.patch — apply instructions

One commit. Multi-branch gym management: branches (name / address / phone /
hours / timezone / status), member primary + allowed branches, staff branch
restrictions, branch-specific plans & attendance, cross-branch QR, branch
transfers with append-only history, and the [All Branches ▼] dashboard.

## PREREQUISITE

Your tree must already include **Phase 14 + Phase 15**
(`gym-phase-14-15.patch` applied → HEAD = "Phase 15 — gym business
dashboard"). This patch applies ON TOP of it (it touches the dashboard,
attendance and announcements surfaces).

## Apply (clean worktree, on `glm-ui`)

```bash
git am gym-phase-16-multi-branch.patch      # or: git am -3 …
# rollback if needed: git am --abort (before) / git revert HEAD (after)
```

## Migrate (REQUIRED — ships migration 056)

```bash
cd backend
npm run migrate        # applies 056_gym_branches.sql
```

056 creates `gym_branches` + `gym_branch_transfers`, adds branch columns to
members / staff / plans / attendance, and **backfills**: every existing
free-form `branch` label on your members becomes a real ACTIVE branch
(inheriting the gym timezone), and those members become its primary members.
The label stays synced, so Phase 14 SPECIFIC_BRANCH announcements keep
working untouched.

## Verify after applying

```bash
cd backend && npm test          # 291 tests; expect 290 pass
# the single failure is exerciseCatalog "meta returns count…" — needs
# exercises_full.json (modernization branch); pre-existing, unrelated.

cd ../gym-web && npm run build && npm test   # tsc clean, vitest 21/21
```

## What you get in the portal

- **Branches** (sidebar, OWNER/ADMIN): create/edit/close/reopen; a closed
  branch blocks NEW check-ins, never loses history.
- **Reports**: `[All Branches ▼]` selector — every KPI group re-scopes to
  Chandigarh / Mohali / Delhi / … in one request; the branch table shows
  members, active and the branch you are viewing.
- **Staff**: per-person *Branch access* editor (empty = all branches;
  owners always have every branch). A Front Desk restricted to "Mohali"
  gets 403 on check-ins elsewhere — enforced server-side.
- **Member detail → Branch card**: primary branch, allowed branches
  (multi-club), transfer-with-history flow.
- **Plans**: "Available at branches" (empty = all branches); assignment is
  blocked when the member's primary branch isn't offered.

## API surface (Phase 16)

```
GET/POST /gym/:gymId/branches            GET/PATCH /gym/:gymId/branches/:id
POST /gym/:gymId/branches/:id/close      POST /gym/:gymId/branches/:id/reopen
PATCH /gym/:gymId/members/:id/branches   POST /gym/:gymId/members/:id/transfer-branch
GET  /gym/:gymId/members/:id/branch-history
PATCH /gym/:gymId/staff/:staffId/branches
GET  /gym/:gymId/dashboard?branch_id=    POST /gym/:gymId/attendance/scan {branch_id}
```
