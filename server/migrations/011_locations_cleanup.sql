-- ═══════════════════════════════════════════════════════════════════════════
-- Only five locations may exist: Kitchen, FOH/Bar, Store, L-4, L-17.
--
-- Migration 010 mapped the old free-text values and CREATED a location for
-- anything it did not recognise, so that no entry lost its location. That was
-- the right call at the time — a guess that moves a recorded quantity into a
-- place it was not counted is worse than an extra row — but it left the
-- legacy vocabulary showing in the auditor's dropdown and as columns on every
-- report. This removes it.
--
-- It removes COUNT DATA, so it will not do so blindly. Before deleting
-- anything it prints what it found, and it ABORTS if a stray location holds
-- entries from an audit that was ever delivered — submitted, closed, or
-- carrying a submission snapshot. Test data on an open, never-submitted audit
-- is safe to drop; a delivered audit is not, and the right answer there is a
-- decision, not a default.
--
-- NOTE: migrations run on start, so an abort here stops the deploy. That is
-- deliberate. It is the loudest possible way to say "a real count is pointing
-- at a location you asked me to delete".
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  keep      CONSTANT text[] := ARRAY['kitchen', 'foh/bar', 'store', 'l-4', 'l-17'];
  r         RECORD;
  protected text := '';
  n_entries int := 0;
  n_snap    int := 0;
  n_locs    int := 0;
BEGIN
  -- ── Report first ─────────────────────────────────────────────────────────
  FOR r IN
    SELECT l.id, l.name,
           (SELECT count(*) FROM count_entries ce WHERE ce.location_id = l.id) AS entries,
           (SELECT count(*) FROM submission_entries se WHERE se.location_id = l.id) AS snap
      FROM locations l
     WHERE lower(btrim(l.name)) <> ALL (keep)
     ORDER BY l.sort_order, l.id
  LOOP
    RAISE NOTICE 'stray location "%" (id %) — % count entries, % snapshot rows',
      r.name, r.id, r.entries, r.snap;
    n_locs := n_locs + 1;
    n_entries := n_entries + r.entries;
    n_snap := n_snap + r.snap;
  END LOOP;

  IF n_locs = 0 THEN
    RAISE NOTICE 'No stray locations. Nothing to clean up.';
    RETURN;
  END IF;
  RAISE NOTICE 'Total: % stray location(s), % count entries, % snapshot rows',
    n_locs, n_entries, n_snap;

  -- ── Refuse to delete a delivered count ───────────────────────────────────
  SELECT string_agg(DISTINCT format('"%s" (audit %s, %s)', l.name, a.id, a.status), '; ')
    INTO protected
    FROM count_entries ce
    JOIN locations l ON l.id = ce.location_id
    JOIN audits a ON a.id = ce.audit_id
   WHERE lower(btrim(l.name)) <> ALL (keep)
     AND (a.status IN ('submitted', 'closed')
          OR EXISTS (SELECT 1 FROM audit_submissions s
                      WHERE s.audit_id = a.id AND s.status IN ('active', 'replaced')));

  IF protected IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to delete: these stray locations hold entries from delivered audits — %. %',
      protected,
      'Reassign or clear them by hand, then re-run. No data has been changed.';
  END IF;

  -- ── Safe to remove ───────────────────────────────────────────────────────
  -- Snapshot rows go first: they are a copy of a count, not the count itself,
  -- and audit_submissions cascades to them anyway.
  DELETE FROM submission_entries se
   USING locations l
   WHERE l.id = se.location_id AND lower(btrim(l.name)) <> ALL (keep);

  DELETE FROM count_entries ce
   USING locations l
   WHERE l.id = ce.location_id AND lower(btrim(l.name)) <> ALL (keep);

  DELETE FROM locations WHERE lower(btrim(name)) <> ALL (keep);

  RAISE NOTICE 'Removed % stray location(s) and the % entries pointing at them.',
    n_locs, n_entries;
END $$;

-- ── The five, exactly ──────────────────────────────────────────────────────
-- Re-asserted rather than assumed: a database that never ran 010, or one where
-- a name or an order was edited, ends up in the same state as a fresh install.
INSERT INTO locations (name, sort_order) VALUES
  ('Kitchen', 1), ('FOH/Bar', 2), ('Store', 3), ('L-4', 4), ('L-17', 5)
ON CONFLICT DO NOTHING;

UPDATE locations SET sort_order = v.ord, is_active = TRUE
  FROM (VALUES ('kitchen', 1), ('foh/bar', 2), ('store', 3), ('l-4', 4), ('l-17', 5))
       AS v(nm, ord)
 WHERE lower(btrim(locations.name)) = v.nm
   AND (locations.sort_order <> v.ord OR NOT locations.is_active);

-- ── location_zones is obsolete ─────────────────────────────────────────────
-- It existed to fold free-text locations into a store_room / outlet split.
-- One column per location says everything that split did and more, from a
-- value the auditor picks rather than a word they type. Nothing reads the
-- table any more, and the setting that went with it goes too.
DROP TABLE IF EXISTS location_zones;
DELETE FROM settings WHERE key = 'location_default_zone';
