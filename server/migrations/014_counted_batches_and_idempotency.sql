-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Batches created by the counter.
--
-- A warehouse counter regularly finds a batch the stock list does not have.
-- They create it on the phone, and it becomes an ordinary, permanent batch of
-- that article — but where it came from is recorded, so the admin can find
-- every batch that was created during counting and see who created it.
--
--   origin = 'stock'    from the stock list (CSV import or the Stock screen)
--   origin = 'counted'  created by a counter during an audit
--
-- 2. Idempotent entries.
--
-- An entry saved on a bad connection can reach the server while the reply is
-- lost. The phone then queues it and sends it again — and used to create it
-- twice. Each save now carries a client-generated reference; the same
-- reference from the same person is the same entry, however often it arrives.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE item_batches ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'stock';
ALTER TABLE item_batches DROP CONSTRAINT IF EXISTS item_batches_origin_check;
ALTER TABLE item_batches ADD CONSTRAINT item_batches_origin_check
  CHECK (origin IN ('stock', 'counted'));

-- SET NULL, never CASCADE: deleting an audit or an account must not take a
-- batch — or the counts recorded against it in other audits — with it.
ALTER TABLE item_batches ADD COLUMN IF NOT EXISTS created_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE item_batches ADD COLUMN IF NOT EXISTS created_in_audit INTEGER
  REFERENCES audits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_item_batches_counted
  ON item_batches (created_in_audit) WHERE origin = 'counted';

ALTER TABLE count_entries ADD COLUMN IF NOT EXISTS client_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_count_entries_client_ref
  ON count_entries (counted_by, client_ref) WHERE client_ref IS NOT NULL;
