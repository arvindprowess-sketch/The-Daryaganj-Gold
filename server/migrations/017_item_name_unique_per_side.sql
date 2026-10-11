-- ═══════════════════════════════════════════════════════════════════════════
-- An item name is unique within its OWN list, not across both.
--
-- The cafe Item Master and the warehouse Stock list are separate (migration
-- 016), but the name index still spanned both, so a warehouse article could
-- not share a name with a cafe item — "Basmati Rice", "Sugar", "Refined Oil"
-- were refused on import simply because the cafe also stocks them.
--
-- Within each list a name is still unique, case-insensitively: the batches of
-- one article all hang off that one article.
-- ═══════════════════════════════════════════════════════════════════════════
DROP INDEX IF EXISTS idx_items_name_lower;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_mode_name
  ON items (inventory_mode, lower(name));
