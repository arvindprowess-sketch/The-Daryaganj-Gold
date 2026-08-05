# Test credentials — Audix Stock Audit

Login page: https://audit-counter-1.preview.emergentagent.com/

Commit `0e79748` added a **forced password change on first login** (`must_change_password`).
The seeded defaults were already consumed, so use the passwords below.

| Role     | Username | Password     | Scope                |
|----------|----------|--------------|----------------------|
| Admin    | admin    | Admin@1234   | Full desktop console |
| Auditor  | rakesh   | Rakesh@1234  | M3M                  |
| Auditor  | sunil    | Sunil@1234   | M3M                  |

Seed defaults (only valid on a freshly seeded DB, then force a password change):
admin/admin123, rakesh/rakesh123, sunil/sunil123.

Change-password API: `POST /api/auth/change-password`
body `{ "current_password": "...", "new_password": "min 8 chars" }` with Bearer token.

Re-seed / repair DB: `bash /app/scripts/init-pg.sh` (idempotent; creates role+db, migrates, seeds if empty).
