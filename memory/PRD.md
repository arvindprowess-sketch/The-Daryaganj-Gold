# The Daryaganj Gold — Audix Stock Audit

## Original problem statement
Build & preview the full-stack app from https://github.com/arvindprowess-sketch/The-Daryaganj-Gold (branch `main`). Monorepo:
- Backend `/server` (Node + Express, ES modules)
- Frontend `/client` (React + Vite + Tailwind)
- PostgreSQL database (provisioned in-pod) — **never MongoDB**

## Architecture (as running in preview)
- **PostgreSQL 15** — local cluster `15/main` on `localhost:5432`, DB `audix`, user `audix/audix`. Managed by supervisor.
- **Backend (`/app/server`)** — Node 20 + Express on **port 8001** (ingress routes `/api/*`).
- **Frontend (`/app/client`)** — Vite dev server on **port 3000**.
- **Preview URL** — https://audit-counter-1.preview.emergentagent.com

## Environment
- `server/.env` — `PORT=8001`, `DATABASE_URL=postgres://audix:audix@localhost:5432/audix`, `JWT_SECRET`, `STORAGE_DRIVER=local`, `PUBLIC_BASE_URL` + `CLIENT_ORIGIN` = preview URL.
- `client/.env` — `VITE_API_URL` = preview URL.

## Timeline
### Session 1
- Cloned repo, installed Postgres 15, ran migrations 001–004, seeded demo data.
- Supervisor configured for node backend (8001), Vite frontend (3000), Postgres.
- Pulled commits `8b01498`, `b93fc0c`, `d2eb838`.

### 2026-06 (this session)
- Pulled new commits `58878c0` (system stock correctable/traceable/guarded) and `0e79748` (data management tools + production safety guards).
- `yarn install` in both workspaces; ran migrations `005_system_stock_provenance.sql`, `006_data_management.sql`.
- Fixed stale preview URL in `server/.env` (`PUBLIC_BASE_URL`, `CLIENT_ORIGIN`) and `client/.env` (`VITE_API_URL`) — old `3a99fe66-...` domain replaced by `audit-counter-1`.
- **Created `/app/scripts/init-pg.sh`** — idempotent DB bootstrap (initdb if data dir wiped, start cluster, create role+db, `npm run migrate`, seed only when `users` is empty). Fixes the recurring `password authentication failed for user "audix"` after pod restarts.
- Seed script renamed: `npm run seed` → `seed/demo.js`; new `npm run seed:reference` (hierarchy only, production-safe).
- Set new passwords for all three demo accounts (new forced-password-change gate). See `memory/test_credentials.md`.
- Verified in preview: login → forced password change → admin dashboard, Item Master (618 items, filters/search), Reports R1–R6 with super-category grouping, **System Readiness** (new), **Data Management** (new, with demo-data banner + typed confirmations).

## Known issues / notes
- **P1 — real item master missing.** `server/seed/Item_Master_Import_Ready.csv` is absent, so the 618 items are MOCKED placeholders. Drop the CSV at that path and re-run `npm run seed` for real data.
- **P1 — pod restart wipes `/var/lib/postgresql`.** `bash /app/scripts/init-pg.sh` restores everything. Supervisor conf is a READONLY platform file and cannot invoke it automatically, so run it manually after a wake-up if login fails.
- **P2 — photo/camera capture flow still untested** end-to-end (b93fc0c photo hardening + object-storage driver). Readiness check says all 618 items have no photo.

## Backlog
- P1: seed real item master from client CSV.
- P2: e2e auditor mobile flow test (login → store → super category → category → item list → count entry with camera photo).
- P2: exercise report exports (XLSX/PDF) and System Stock upload/correction flow from commit `58878c0`.
