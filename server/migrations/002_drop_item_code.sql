-- ═══════════════════════════════════════════════════════════════════════════
-- The client's inventory does not use item codes. Item NAME is the single
-- identifier everywhere: screens, CSV import/export, photo matching, reports.
-- ═══════════════════════════════════════════════════════════════════════════

-- Normalise existing names first (trim, collapse internal whitespace) so the
-- unique index below cannot fail on cosmetic differences.
UPDATE items SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'));

-- Merge-safe: if normalisation created duplicates, keep the lowest id and
-- point any count entries / system stock at the survivor before dropping.
WITH ranked AS (
  SELECT id, lower(name) AS lname,
         min(id) OVER (PARTITION BY lower(name)) AS keep_id
    FROM items
)
UPDATE count_entries ce SET item_id = r.keep_id
  FROM ranked r WHERE ce.item_id = r.id AND r.id <> r.keep_id;

WITH ranked AS (
  SELECT id, min(id) OVER (PARTITION BY lower(name)) AS keep_id FROM items
)
UPDATE system_stock ss SET item_id = r.keep_id
  FROM ranked r WHERE ss.item_id = r.id AND r.id <> r.keep_id;

WITH ranked AS (
  SELECT id, min(id) OVER (PARTITION BY lower(name)) AS keep_id FROM items
)
DELETE FROM audit_na na USING ranked r
 WHERE na.item_id = r.id AND r.id <> r.keep_id;

WITH ranked AS (
  SELECT id, min(id) OVER (PARTITION BY lower(name)) AS keep_id FROM items
)
DELETE FROM items i USING ranked r WHERE i.id = r.id AND r.id <> r.keep_id;

-- Drop the code column entirely.
ALTER TABLE items DROP COLUMN IF EXISTS code;

-- Name is now the identifier: unique, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_name_lower ON items (lower(name));
