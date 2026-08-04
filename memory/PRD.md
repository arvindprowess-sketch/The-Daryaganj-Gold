# The Daryaganj Gold — Audix Stock Audit

## Original problem statement
Build & preview the full-stack app from https://github.com/arvindprowess-sketch/The-Daryaganj-Gold (branch `main`). Monorepo:
- Backend `/server` (Node + Express, ES modules)
- Frontend `/client` (React + Vite + Tailwind)
- PostgreSQL database (provisioned in-pod)

## Architecture (as running in preview)
- **PostgreSQL 15** — installed locally, cluster `15/main` on `localhost:5432`, DB `audix`, user `audix/audix`. Managed by supervisor.
- **Backend (`/app/server`)** — Node 20 + Express, ES modules. Runs on **port 8001** (Kubernetes ingress routes `/api/*` here). Started via `npm start` under supervisor.
- **Frontend (`/app/client`)** — Vite dev server on **port 3000** (ingress routes non-`/api` traffic here). `vite.config.js` proxies `/uploads` to `http://localhost:8001`. Started via `npx vite` under supervisor.
- **Public preview URL** — https://3a99fe66-fbc9-4e0b-ba1e-eff798987233.preview.emergentagent.com

## Environment
- `server/.env` — `PORT=8001`, `DATABASE_URL=postgres://audix:audix@localhost:5432/audix`, `JWT_SECRET`, `STORAGE_DRIVER=local`, `PUBLIC_BASE_URL` and `CLIENT_ORIGIN` set to the preview URL.
- `client/.env` — `VITE_API_URL` set to preview URL (client actually uses relative `/api` paths).

## Setup done
- `apt install postgresql-15` + created role/db.
- `yarn install` in `/app/server` and `/app/client`.
- `npm run migrate` (applied `001_init.sql`) and `npm run seed` in `/app/server`.
- Supervisor rewritten to run `node` backend on 8001, Vite frontend on 3000, and Postgres cluster.

## Verified end-to-end
- `GET /api/health` → `{"ok":true}` via public URL.
- `POST /api/auth/login` returns JWT for both `admin` and `rakesh`.
- Admin UI loads at `/admin` after login, "Live audit dashboard" shows Aerocity Outlet (9/30, seeded data).

## Test credentials
- Admin — `admin` / `admin123`
- Auditor — `rakesh` / `rakesh123` (Aerocity + CP)
- Auditor — `sunil` / `sunil123` (Aerocity)

## Backlog / Next
- Test the auditor mobile counting flow end-to-end (login → store → sections → item list → count entry, camera capture).
- Exercise admin reports (PDF/XLSX exports via `pdfkit`/`xlsx`).
