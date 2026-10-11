-- ═══════════════════════════════════════════════════════════════════════════
-- Warehouse articles are identified by ARTICLE and BARCODE.
--
-- The counter types (or scans) one of the two to find an article; the
-- description is shown for reference only. A barcode belongs to one article
-- within its list, so typing it always lands on exactly one article.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE items ADD COLUMN IF NOT EXISTS barcode TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_mode_barcode
  ON items (inventory_mode, lower(btrim(barcode)))
  WHERE barcode IS NOT NULL AND btrim(barcode) <> '';
