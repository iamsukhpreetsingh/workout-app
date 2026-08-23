# Workout Tracker — Admin Dashboard

Internal web admin (React + TypeScript + Vite + Ant Design + Recharts).
Talks ONLY to the `/admin/*` API on the existing Express backend (dev proxy
configured in `vite.config.ts`).

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (proxies /admin → localhost:4000)
npm run build      # static bundle in dist/ for deployment
```

**First login**: the backend creates a bootstrap super admin on first start
— `admin@workout.local` / `ChangeMe123!` (logged once to the backend
console). CHANGE THIS PASSWORD immediately; create real admin accounts
(Users → Admins is via `/admin/admins`, super admin only) and deactivate
the bootstrap one.

## Sections

| Section | What it is |
|---|---|
| Dashboard | Platform analytics: totals, DAU/WAU/MAU, workouts, signup trend, retention cohorts |
| Database | **Auto-discovering** generic entity browser — every public Postgres table appears automatically; new migrations need zero dashboard changes |
| API Explorer | **Auto-discovering** live API reference from the backend's `registerRoute()` registry, with read-only "Try it" for GETs |
| Users & Trainers | Search, detail views, suspend/reactivate, force-logout, role change, trainer client rosters, read-only impersonation |
| Content | Report queue, platform-wide content removal, tag vocabulary + duplicate merging |
| System Health | Push failure rates, archive/purge status, manual purge trigger |
| Broadcast | Segmented in-app/push notifications with audience-size confirmation |
| Feature Flags | Remote kill-switches / gradual rollouts (mobile app polls `/config/feature-flags`) |
| Audit Log | Every admin write/delete, attributable (super admin only) |

## Roles

`super_admin` · `support` · `content_moderator` · `analyst` · `read_only` —
enforced server-side on every `/admin/*` endpoint; the UI merely hides what
a role can't use.

## The extensibility contract

- New **table** (any migration) → appears in Database automatically.
  Only touch `backend/src/admin/tableConfig.js` if the table needs
  exclusion, sensitive-column masking beyond the global list, different
  role requirements, or routing to a custom module.
- New **endpoint** → register it with `registerRoute()` in the backend and
  it appears in API Explorer automatically.
