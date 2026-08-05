# Test credentials — Audix Stock Audit

Preview: https://audit-counter-1.preview.emergentagent.com/

## Current (Neon production DB — go-live account)
| Role  | Username | Password            | Notes |
|-------|----------|---------------------|-------|
| Admin | arvind   | Daryaganj@Gold2026  | Real admin (`is_demo=false`), created via `npm run create:admin`. First-login password change already completed. |

The database is now **Neon Postgres** (`ep-fragrant-rain-axpdjywl...us-east-2.aws.neon.tech/neondb`),
seeded with reference hierarchy only — **no demo users, no items, no stores**.

## Demo accounts (only exist if `npm run seed:demo` is run)
admin/admin123, rakesh/rakesh123, sunil/sunil123 — each forced to change password at first login.
Earlier local-Postgres session used: admin/Admin@1234, rakesh/Rakesh@1234, sunil/Sunil@1234.

## Notes
- Login is rate limited: **10 attempts / 15 min per IP**. If locked out, `sudo supervisorctl restart backend` clears the in-memory counter.
- Change password API: `POST /api/auth/change-password` with `{ "current_password", "new_password" }` (min 8 chars) + Bearer token.
- Create another real admin: `cd /app/server && npm run create:admin -- --username <u> --name "<n>" --password '<p>'`
- Local Postgres bootstrap (no longer used by the app, kept for offline work): `bash /app/scripts/init-pg.sh`
