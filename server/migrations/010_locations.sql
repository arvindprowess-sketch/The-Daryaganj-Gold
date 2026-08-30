-- ═══════════════════════════════════════════════════════════════════════════
-- Locations become a fixed, GLOBAL list.
--
-- Location was free text on every entry. Two auditors writing "Store Room" and
-- "store room" produced two columns in the report, and the report could only
-- ever show a store_room / outlet split because free text cannot be a column
-- header. A chosen id fixes both: the report has one column per location, and
-- an auditor cannot spell one wrong.
--
-- The list is GLOBAL, not per store. The same five places exist in every
-- outlet, and scoping it to store_id would mean maintaining five copies of the
-- same list and reports that cannot be compared across stores.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS locations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One name, however it is typed. This is what makes the mapping below safe and
-- stops a renamed location colliding with an existing one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_name ON locations (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_locations_order ON locations (sort_order, id);

INSERT INTO locations (name, sort_order) VALUES
  ('Kitchen', 1), ('FOH/Bar', 2), ('Store', 3), ('L-4', 4), ('L-17', 5)
ON CONFLICT DO NOTHING;

-- location_text stays on the row. It is the ORIGINAL text the auditor typed,
-- and an audit trail does not get rewritten because the schema improved — if a
-- mapping below is ever questioned, the words that were actually recorded are
-- still there to check it against.
ALTER TABLE count_entries      ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id);
ALTER TABLE submission_entries ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id);

CREATE INDEX IF NOT EXISTS idx_count_entries_location ON count_entries (audit_id, location_id);
CREATE INDEX IF NOT EXISTS idx_submission_entries_location ON submission_entries (submission_id, location_id);

-- ── Mapping the free text that already exists ──────────────────────────────
-- Two steps, and the order matters.
--
-- STEP 1 creates a location for every distinct value that is not already one.
-- It deliberately does NOT guess: "Bar" is not silently folded into "FOH/Bar"
-- and "Store Room" is not folded into "Store". On an audit trail, a guess that
-- moves a recorded quantity into a place it was not counted is worse than an
-- extra column — the admin can merge them on the Locations screen, having seen
-- what was actually there. Matching is on the name, case- and
-- whitespace-insensitive, so "kitchen" and "Kitchen " do map to Kitchen.
INSERT INTO locations (name, sort_order, is_active)
SELECT DISTINCT btrim(ce.location_text),
       100 + dense_rank() OVER (ORDER BY lower(btrim(ce.location_text)))::int,
       TRUE
  FROM count_entries ce
 WHERE COALESCE(btrim(ce.location_text), '') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM locations l
      WHERE lower(btrim(l.name)) = lower(btrim(ce.location_text))
   )
ON CONFLICT DO NOTHING;

-- STEP 2 attaches every entry to its location. Nothing is dropped: after step 1
-- every non-blank value has a row to point at.
UPDATE count_entries ce
   SET location_id = l.id
  FROM locations l
 WHERE ce.location_id IS NULL
   AND lower(btrim(l.name)) = lower(btrim(COALESCE(ce.location_text, '')));

UPDATE submission_entries se
   SET location_id = l.id
  FROM locations l
 WHERE se.location_id IS NULL
   AND lower(btrim(l.name)) = lower(btrim(COALESCE(se.location_text, '')));

-- Entries recorded with NO location at all predate the mandatory dropdown.
-- They are given an explicit, visible home rather than being quietly counted
-- into one of the real places or dropped from the report.
INSERT INTO locations (name, sort_order, is_active) VALUES ('Unspecified', 999, TRUE)
ON CONFLICT DO NOTHING;

UPDATE count_entries
   SET location_id = (SELECT id FROM locations WHERE lower(btrim(name)) = 'unspecified')
 WHERE location_id IS NULL;

UPDATE submission_entries
   SET location_id = (SELECT id FROM locations WHERE lower(btrim(name)) = 'unspecified')
 WHERE location_id IS NULL;

-- Deactivate 'Unspecified' when nothing needed it, so a clean database does not
-- carry a location that exists only for history.
UPDATE locations SET is_active = FALSE
 WHERE lower(btrim(name)) = 'unspecified'
   AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.location_id = locations.id);
