-- ═══════════════════════════════════════════════════════════════════════════
-- Cafe or warehouse is a property of the STORE, not of the deployment.
--
-- One installation serves both: a cafe outlet is counted by super category
-- with a blind count, a warehouse batch by batch with each batch's book
-- quantity shown. The app picks the right screens from the store being
-- audited — nobody chooses a mode at login, and no server setting is needed.
--
-- Every existing store stays a cafe, exactly as it was.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE stores ADD COLUMN IF NOT EXISTS inventory_mode TEXT NOT NULL DEFAULT 'cafe';
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_inventory_mode_check;
ALTER TABLE stores ADD CONSTRAINT stores_inventory_mode_check
  CHECK (inventory_mode IN ('cafe', 'warehouse'));
