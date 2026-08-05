-- ═══════════════════════════════════════════════════════════════════════════
-- System stock provenance, history and correction.
--
-- A wrong file imported against the wrong audit used to produce a complete but
-- entirely wrong variance report, with nothing to show where the figures came
-- from and no way to undo. This adds:
--   * a per-import record (kept even after it is replaced or cleared)
--   * an activity log for clears, replacements and single-figure corrections
--   * a link from each system_stock row back to the import that created it
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Import history ─────────────────────────────────────────────────────────
-- One row per import attempt that was committed. Superseded imports are marked
-- 'replaced' (never deleted) so an admin can always see that a re-import
-- happened and when.
CREATE TABLE IF NOT EXISTS system_stock_imports (
  id              SERIAL PRIMARY KEY,
  audit_id        INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  matched_count   INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  imported_by     INTEGER REFERENCES users(id),
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'replaced', 'cleared')),
  -- Set when the importer overrode a blocking guard (e.g. a LOC mismatch).
  override_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_ss_imports_audit ON system_stock_imports (audit_id);
-- At most one active import per audit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_imports_one_active
  ON system_stock_imports (audit_id) WHERE status = 'active';

-- ── Link each figure to the import that produced it ────────────────────────
-- NULL means the figure was entered or corrected by hand.
ALTER TABLE system_stock ADD COLUMN IF NOT EXISTS import_id INTEGER
  REFERENCES system_stock_imports(id) ON DELETE SET NULL;
ALTER TABLE system_stock ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
ALTER TABLE system_stock ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ── Activity log ───────────────────────────────────────────────────────────
-- Append-only audit trail for administrative actions. `detail` carries the
-- before/after values so a correction can be reconstructed later.
CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  audit_id    INTEGER REFERENCES audits(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,          -- e.g. 'system_stock'
  entity_id   INTEGER,                -- item_id / import_id where applicable
  action      TEXT NOT NULL,          -- 'import', 'replace', 'clear', 'update', 'delete'
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id     INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_audit ON activity_log (audit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log (entity_type, entity_id);

-- ── A missing system figure is NULL, never zero ────────────────────────────
-- "system says 0, physical found 5" is a genuine excess; "no row for this item"
-- is a data gap. qty is already nullable (migration 003); make the intent
-- explicit and ensure no legacy DEFAULT 0 can reintroduce a false zero.
ALTER TABLE system_stock ALTER COLUMN qty DROP DEFAULT;
