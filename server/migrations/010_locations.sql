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
-- Matching is on the name, case- and whitespace-insensitive, so "kitchen" and
-- "Kitchen " both map to Kitchen.
--
-- An earlier version of this migration CREATED a location for every value it
-- did not recognise, so that no entry lost its location. That left the legacy
-- vocabulary in the auditor's dropdown and as columns on every report.
--
-- The list is now fixed at five, so an unrecognised value is REPORTED, never
-- added. It is not an abort: migrations run on start, and taking the whole
-- deployment down over a DATA question is a far worse outcome than a handful
-- of entries needing a decision. The values are named in the deploy log and
-- counted on Admin -> System Readiness, so they cannot be missed.
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

DO $$
DECLARE
  unmatched text;
  blanks    int;
BEGIN
  SELECT string_agg(DISTINCT format('"%s"', btrim(location_text)), ', ')
    INTO unmatched
    FROM count_entries
   WHERE location_id IS NULL AND COALESCE(btrim(location_text), '') <> '';

  SELECT count(*) INTO blanks
    FROM count_entries
   WHERE location_id IS NULL AND COALESCE(btrim(location_text), '') = '';

  IF unmatched IS NOT NULL OR blanks > 0 THEN
    RAISE WARNING
      'Count entries reference locations that are not in the list: %. % entries have no location at all. %',
      COALESCE(unmatched, '(none)'), blanks,
      'Nothing has been created. Reassign them to one of Kitchen / FOH/Bar / Store / L-4 / L-17 — until then they carry no location and are left out of the location columns. Admin -> System Readiness counts them.';
  END IF;
END $$;
