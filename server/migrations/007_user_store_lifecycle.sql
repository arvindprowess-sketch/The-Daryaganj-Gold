-- ═══════════════════════════════════════════════════════════════════════════
-- Deleting users and stores.
--
-- Users and stores could be created but never removed. Removing them naively
-- is not an option either: a user is referenced by every count entry they
-- recorded, and a store by every audit ever run against it. Hard deleting
-- would orphan audit history — the one thing this system must never do.
--
-- So the rule is the same one already used for items:
--   * referenced by history  → DEACTIVATE (is_active = FALSE), stays visible
--                              in historical reports, gone from dropdowns
--   * never referenced       → hard delete
--
-- This migration records WHEN and BY WHOM a deactivation happened, and makes
-- the activity log survive a hard-deleted user.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Deactivation provenance ────────────────────────────────────────────────
-- `is_active` already exists on both tables (migration 001). These columns let
-- the management screen explain an inactive row rather than just greying it.
ALTER TABLE users  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES users(id);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_users_active  ON users (is_active);
CREATE INDEX IF NOT EXISTS idx_stores_active ON stores (is_active);

-- ── Activity log keeps its attribution after a hard delete ─────────────────
-- activity_log.user_id is a foreign key, so hard deleting a user would either
-- fail or null the column, and "who did this" would be lost from the audit
-- trail. Snapshot the name at write time; the log then reads correctly forever,
-- whatever later happens to the account.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_label TEXT;

UPDATE activity_log al
   SET user_label = u.name || ' (' || u.username || ')'
  FROM users u
 WHERE u.id = al.user_id
   AND al.user_label IS NULL;
