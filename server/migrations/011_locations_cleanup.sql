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
-- anything it prints what it found, and it SKIPS any stray location holding
-- entries from an audit that was ever delivered — submitted, closed, or
-- carrying a submission snapshot. Test data on an open, never-submitted audit
-- is safe to drop; a delivered count is a decision, not a default.
--
-- Skipping, not aborting. Migrations run on start, so raising here would take
-- the whole deployment down over a DATA question — an app that cannot boot is
-- a far worse outcome than a location left in the list one release longer.
-- What is protected is reported in the deploy log and flagged on Admin →
-- System Readiness, so it is impossible to miss and can be resolved without a
-- migration.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  keep      CONSTANT text[] := ARRAY['kitchen', 'foh/bar', 'store', 'l-4', 'l-17'];
  r         RECORD;
  protected text := '';
  n_entries int := 0;
  n_snap    int := 0;
  n_locs    int := 0;
  n_removed int := 0;
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

  -- ── Which strays are off limits ──────────────────────────────────────────
  -- A location holding entries from a DELIVERED audit is left exactly as it
  -- is. Nobody should quietly delete a count that has already been sent.
  CREATE TEMP TABLE _protected_locations ON COMMIT DROP AS
  SELECT DISTINCT l.id, l.name
    FROM count_entries ce
    JOIN locations l ON l.id = ce.location_id
    JOIN audits a ON a.id = ce.audit_id
   WHERE lower(btrim(l.name)) <> ALL (keep)
     AND (a.status IN ('submitted', 'closed')
          OR EXISTS (SELECT 1 FROM audit_submissions s
                      WHERE s.audit_id = a.id AND s.status IN ('active', 'replaced')));

  SELECT string_agg(format('"%s"', name), ', ') INTO protected FROM _protected_locations;

  IF protected IS NOT NULL THEN
    -- Kept, but DEACTIVATED: it leaves the auditor's dropdown immediately, so
    -- nothing new can be counted there, while its report column survives for
    -- as long as the delivered audit references it and the figures still
    -- reconcile.
    UPDATE locations SET is_active = FALSE
     WHERE id IN (SELECT id FROM _protected_locations) AND is_active;

    RAISE NOTICE 'KEEPING % — they hold entries from a delivered audit, and are now DEACTIVATED. %',
      protected,
      'Reassign or clear those entries and this cleanup removes them on the next deploy. Admin -> System Readiness lists them.';
  END IF;

  -- ── Remove what is safe ──────────────────────────────────────────────────
  -- Snapshot rows go first: they are a copy of a count, not the count itself,
  -- and audit_submissions cascades to them anyway.
  DELETE FROM submission_entries se
   USING locations l
   WHERE l.id = se.location_id
     AND lower(btrim(l.name)) <> ALL (keep)
     AND l.id NOT IN (SELECT id FROM _protected_locations);

  DELETE FROM count_entries ce
   USING locations l
   WHERE l.id = ce.location_id
     AND lower(btrim(l.name)) <> ALL (keep)
     AND l.id NOT IN (SELECT id FROM _protected_locations);

  DELETE FROM locations
   WHERE lower(btrim(name)) <> ALL (keep)
     AND id NOT IN (SELECT id FROM _protected_locations);

  GET DIAGNOSTICS n_removed = ROW_COUNT;
  RAISE NOTICE 'Removed % stray location(s). % kept for now.',
    n_removed, n_locs - n_removed;
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
