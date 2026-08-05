-- ═══════════════════════════════════════════════════════════════════════════
-- Data management and production safety.
--
--   * Demo records are identified by an explicit FLAG, never by guessing from
--     names, so cleanup is exact.
--   * Seeded accounts must change their password at first login.
--   * The activity log records who removed what, and how much of it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Demo marking ───────────────────────────────────────────────────────────
-- Set to TRUE only by `npm run seed:demo`. Anything created through the UI or
-- a CSV import is FALSE, so "delete demo data" can never touch real records.
ALTER TABLE users         ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE items         ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE audits        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE count_entries ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_demo         ON users (is_demo)         WHERE is_demo;
CREATE INDEX IF NOT EXISTS idx_stores_demo        ON stores (is_demo)        WHERE is_demo;
CREATE INDEX IF NOT EXISTS idx_items_demo         ON items (is_demo)         WHERE is_demo;
CREATE INDEX IF NOT EXISTS idx_audits_demo        ON audits (is_demo)        WHERE is_demo;
CREATE INDEX IF NOT EXISTS idx_count_entries_demo ON count_entries (is_demo) WHERE is_demo;

-- ── Forced password change for seeded accounts ─────────────────────────────
-- Seeded passwords are printed to a console; such an account must not stay
-- usable with its default credentials.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- ── Activity log: destructive-action fields ────────────────────────────────
-- The table exists from migration 005 (system stock provenance). Destructive
-- data-management actions share it, so the firm has ONE place that answers
-- "who removed that data and when".
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS record_count INTEGER;
-- `entity_type` / `entity_id` are the historical names; expose the wording the
-- data-management screens use without breaking the existing rows.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS target_id INTEGER;

-- Backfill so old rows read consistently on the new screen.
UPDATE activity_log SET target_type = entity_type WHERE target_type IS NULL;
UPDATE activity_log SET target_id = entity_id WHERE target_id IS NULL AND entity_id IS NOT NULL;

-- audit_id is nullable already, but a global action (e.g. deleting the whole
-- item master) has no audit; make sure deleting an audit cannot erase its own
-- log entry.
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_audit_id_fkey;
ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_audit_id_fkey
  FOREIGN KEY (audit_id) REFERENCES audits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at DESC);

-- ── Soft delete support ────────────────────────────────────────────────────
-- `items.is_active` already exists. Record when and by whom an item was
-- deactivated so the item master can explain an inactive row.
ALTER TABLE items ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES users(id);
