# Gym Portal (`gym-web`)

The web surface for gym **owners and staff** — create a gym, configure its
profile, and manage it. Standalone Vite + React 18 + TypeScript + AntD 5,
mirroring `../admin-dashboard` patterns but a **separate trust domain**: it
authenticates regular `users` through `/auth` (same accounts as the mobile
app) and speaks to the `/gym` API. Platform-admin trust stays in
`admin-dashboard`; member-facing features live in the mobile app.

## Run

```bash
npm install
npm run dev        # http://localhost:5174 — proxies /auth and /gym to :4000
npm run build      # tsc -b && vite build
```

## What's implemented (Phase 2 — onboarding & setup)

- **Login / sign-up** — the same account as the mobile app. Creating a gym
  never touches personal fitness data: workouts, diet, progress and trainer
  relationships are untouched, and the gym role (OWNER) is scoped to that
  gym only.
- **Create Gym wizard** — Gym Name (name/timezone/currency) → Contact
  Information → Address → Operating Hours (7-day editor, closed days
  explicit) → Branding (colors) → Review → Create → Dashboard. Client-side
  validation is convenience; the backend re-validates everything.
- **Dashboard** — profile-completion dashboard (percent + missing checklist
  from the server), gym summary, deactivated-gym warning with owner
  self-service reactivation. Loading skeletons, error alerts with retry,
  and an explicit empty state when no gym exists yet.
- **Settings** — Gym Profile (name/timezone/currency/logo/status),
  Branding, Operating Hours, Contact Information (phone/email/website/
  address). The logo endpoint streams authorized bytes (token-fetched blob
  URL), max 2MB PNG/JPEG/WEBP.
- **Multi-gym** — header switcher; the selected gym id travels as a
  selector (`X-Gym-Id` / URL), never as proof of authorization.

## Deliberately not here yet

Membership plans, payments, attendance, classes, staff UI (API exists),
trainer assignments — see `../GYM_MANAGEMENT_DESIGN.md` §16 for phasing.

## Security model

The portal hides UI by role, but the **backend is the authority**: every
`/gym` request re-resolves the caller's staff/member row and gym-scoped
role from the JWT (`requireGymContext` → `requireGymPermission`). A stolen
gym id, header, or URL grants nothing.
