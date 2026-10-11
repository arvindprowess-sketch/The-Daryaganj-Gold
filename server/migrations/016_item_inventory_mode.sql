-- ═══════════════════════════════════════════════════════════════════════════
-- Cafe items and warehouse articles are separate lists.
--
-- They shared one table with nothing to tell them apart, so a warehouse audit
-- listed every cafe item (and its categories) and the Item Master listed every
-- warehouse article. Each item now belongs to one side:
--
--   cafe       the Item Master — counted in cafe stores
--   warehouse  the Stock list  — counted, batch by batch, in warehouse stores
--
-- An audit shows only the items of its store's side. Categories stay one
-- shared, admin-managed list; a card appears only where it has items.
--
-- Existing items are cafe items, except those that already have batches,
-- which can only have come from the Stock screen.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_mode TEXT NOT NULL DEFAULT 'cafe';
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_inventory_mode_check;
ALTER TABLE items ADD CONSTRAINT items_inventory_mode_check
  CHECK (inventory_mode IN ('cafe', 'warehouse'));

UPDATE items i SET inventory_mode = 'warehouse'
 WHERE inventory_mode = 'cafe'
   AND EXISTS (SELECT 1 FROM item_batches b WHERE b.item_id = i.id);

CREATE INDEX IF NOT EXISTS idx_items_mode_active ON items (inventory_mode, is_active);
