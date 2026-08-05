-- ═══════════════════════════════════════════════════════════════════════════
-- Hierarchy change: the client's inventory master is two levels deep and our
-- reports must reconcile against THEIR system, so we adopt their structure
-- and their wording:
--
--     super_categories  →  categories  →  items
--
-- Both levels are ordinary admin-manageable rows, not hardcoded constants —
-- the client can add a super category or category at any time.
--
-- This is a RENAME, not a drop-and-recreate: existing rows, foreign keys and
-- count history are preserved.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. sections → super_categories ─────────────────────────────────────────
ALTER TABLE IF EXISTS sections RENAME TO super_categories;

-- Keep the sequence / primary key names consistent with the new table name.
ALTER SEQUENCE IF EXISTS sections_id_seq RENAME TO super_categories_id_seq;
ALTER INDEX IF EXISTS sections_pkey RENAME TO super_categories_pkey;

-- ── 2. categories.section_id → categories.super_category_id ────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'categories' AND column_name = 'section_id'
  ) THEN
    ALTER TABLE categories RENAME COLUMN section_id TO super_category_id;
  END IF;
END $$;

-- ── 3. items.section_id → items.super_category_id ──────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'items' AND column_name = 'section_id'
  ) THEN
    ALTER TABLE items RENAME COLUMN section_id TO super_category_id;
  END IF;
END $$;

-- ── 4. Unit is plain text, shown exactly as the client's master supplies it ──
-- No reference table, no enum, no normalisation. Strings such as
-- "CAN (5 LTR)", "BTL (500 ML)", "TIN (850 GM)", "POR", "BOT-680G",
-- "Pkt (50 pcs)" must round-trip unchanged. Widen to plain TEXT and drop any
-- default so nothing is silently substituted.
ALTER TABLE items ALTER COLUMN unit TYPE TEXT;
ALTER TABLE items ALTER COLUMN unit DROP DEFAULT;

-- ── 5. Indexes for 618-items-per-store performance ─────────────────────────
-- Item search is by name; the unique lower(name) index from migration 002
-- already serves exact lookups. These support the hierarchy filters and the
-- per-super-category / per-category progress aggregates.
CREATE INDEX IF NOT EXISTS idx_items_super_category ON items (super_category_id);
CREATE INDEX IF NOT EXISTS idx_items_category ON items (category_id);
CREATE INDEX IF NOT EXISTS idx_items_active ON items (is_active);
CREATE INDEX IF NOT EXISTS idx_categories_super_category ON categories (super_category_id);

-- Trigram index for fast substring search on item name (618 rows per store
-- today, but the search box filters as the user types).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON items USING gin (name gin_trgm_ops);

-- Progress counts are computed by aggregate queries that group active entries
-- per audit; this index keeps that a single indexed scan.
CREATE INDEX IF NOT EXISTS idx_count_entries_audit_active
  ON count_entries (audit_id, item_id) WHERE status = 'active';

-- Category names are unique within a super category (the client's own rule:
-- "LIQUOR" appears once under LIQUOR, "BEVERAGES" once under BEVERAGES).
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_per_super
  ON categories (super_category_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_super_categories_name_lower
  ON super_categories (lower(name));
