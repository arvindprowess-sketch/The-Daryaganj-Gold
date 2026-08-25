-- ═══════════════════════════════════════════════════════════════════════════
-- Bottle/unit size, and Store Room vs Outlet zones.
--
-- The client's standard audit report expresses every item in its measurement
-- base — millilitres, grams, kilos or a plain count — not in packs. That needs
-- ONE multiplier that applies to every item, not a liquor-only bottle size:
--
--   Final Total Qty = (Store Room Qty + Outlet Qty) × Bottle/Unit Size + Loose ML
--
-- A count-based item (Nos, Pcs, Por, Pkt) carries 1, so the multiplier has no
-- effect and the same formula covers the whole master.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Bottle / unit size ─────────────────────────────────────────────────────
-- NOT NULL DEFAULT 1: an item nobody has sized yet must pass through the
-- formula unchanged rather than multiply its quantity to zero.
ALTER TABLE items ADD COLUMN IF NOT EXISTS bottle_unit_size NUMERIC(12,3) NOT NULL DEFAULT 1;

-- Seed it from the liquor-only column it supersedes, so existing liquor items
-- are correct on day one. `bottle_size_ml` stays in place: R3 Liquor and the
-- readiness check still read it, and it is kept in step from here on.
UPDATE items
   SET bottle_unit_size = bottle_size_ml
 WHERE is_liquor
   AND bottle_size_ml IS NOT NULL
   AND bottle_size_ml > 0
   AND bottle_unit_size = 1;

-- A size of zero would silently wipe out an item's whole quantity.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_bottle_unit_size_positive;
ALTER TABLE items ADD CONSTRAINT items_bottle_unit_size_positive
  CHECK (bottle_unit_size > 0);

-- ── Store Room vs Outlet ───────────────────────────────────────────────────
-- Count entries record a free-text location. The report splits physical
-- quantity into two columns, so each location name an auditor actually types
-- has to be assigned to one side. Admin-managed, because the names come from
-- the client's own vocabulary ("Dry Store", "Bar", "Cold Room") and cannot be
-- guessed reliably.
CREATE TABLE IF NOT EXISTS location_zones (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  zone       TEXT NOT NULL CHECK (zone IN ('store_room', 'outlet')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matching is case-insensitive on a trimmed name, the same rule used for item
-- names everywhere else in this system.
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_zones_name
  ON location_zones (lower(btrim(name)));

-- Where an unrecognised location lands. Explicit and visible on the settings
-- screen, so a quantity is never quietly dropped from both columns.
INSERT INTO settings (key, value) VALUES ('location_default_zone', 'outlet')
ON CONFLICT (key) DO NOTHING;

-- A starting vocabulary. These are only defaults — the admin edits the list,
-- and anything already typed that is not here shows up as unmapped.
INSERT INTO location_zones (name, zone) VALUES
  ('Store Room', 'store_room'),
  ('Store', 'store_room'),
  ('Dry Store', 'store_room'),
  ('Cold Room', 'store_room'),
  ('Freezer', 'store_room'),
  ('Outlet', 'outlet'),
  ('Bar', 'outlet'),
  ('Kitchen', 'outlet'),
  ('Counter', 'outlet'),
  ('Floor', 'outlet')
ON CONFLICT DO NOTHING;
