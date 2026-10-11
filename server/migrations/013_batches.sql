-- ═══════════════════════════════════════════════════════════════════════════
-- Batch-wise stock, for the WAREHOUSE deployment.
--
-- A warehouse holds the same article in several batches, each with its own
-- book quantity, and the physical count has to be recorded against the batch
-- rather than the article. The cafe deployment does not use any of this:
--
--   * every new column is NULLABLE, so existing rows and every existing query
--     read exactly as before
--   * an article with no batches is counted exactly as it always was
--   * which screens appear is decided by INVENTORY_MODE (server env), not by
--     the schema — the cafe runs with the default, `cafe`
--
-- Article = items.name (still the identifier). A batch belongs to one article.
-- ═══════════════════════════════════════════════════════════════════════════

-- The warehouse stock list carries a description beside the article name, and
-- the auditor searches both.
ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS item_batches (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  batch_no    TEXT NOT NULL,
  -- NULL means "same unit as the article". Plain text, shown exactly as
  -- uploaded, the same rule as items.unit.
  unit        TEXT,
  -- The book (system) quantity of this batch, in the batch's unit. NULL means
  -- nobody has supplied one — never read as zero.
  qty         NUMERIC(14,3),
  expiry_date DATE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ
);

-- A batch number is unique within its article, however it is typed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_batches_no
  ON item_batches (item_id, lower(btrim(batch_no)));
CREATE INDEX IF NOT EXISTS idx_item_batches_item ON item_batches (item_id) WHERE is_active;

-- The count is recorded against the batch. NULL on every cafe entry, and on a
-- warehouse article that has no batches.
ALTER TABLE count_entries      ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES item_batches(id);
ALTER TABLE submission_entries ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES item_batches(id);

CREATE INDEX IF NOT EXISTS idx_count_entries_batch
  ON count_entries (audit_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submission_entries_batch
  ON submission_entries (submission_id, batch_id) WHERE batch_id IS NOT NULL;
