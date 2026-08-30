-- ═══════════════════════════════════════════════════════════════════════════
-- One count per AUDITOR, not one per store.
--
-- Three auditors in the same outlet were sharing one sheet: they saw each
-- other's ticks, each other's totals, and each other's progress. Now each one
-- works from a blank sheet and sees only their own entries, and the admin
-- portal combines whatever has been submitted.
--
-- The schema change is small — a submission is now identified by
-- (audit_id, submitted_by) rather than by audit_id alone — but the DATA change
-- is not: an existing submission may hold entries from several auditors, and
-- those have to be split apart before the new unique index can exist.
-- ═══════════════════════════════════════════════════════════════════════════

-- submitted_by is now part of a submission's identity, so it must be present.
-- A pre-009 backfill could leave it null when an audit had no entries to infer
-- an auditor from; those rows have nothing to attribute and nothing to split.
DELETE FROM audit_submissions
 WHERE submitted_by IS NULL
   AND NOT EXISTS (SELECT 1 FROM submission_entries se WHERE se.submission_id = audit_submissions.id);

-- ── Identity is now (audit_id, submitted_by) ───────────────────────────────
-- This comes BEFORE the split: the old index allowed only one active
-- submission per audit, so the split could not insert the second auditor's
-- row while it was still in place.
DROP INDEX IF EXISTS idx_audit_submissions_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_submissions_active
  ON audit_submissions (audit_id, submitted_by) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_audit_submissions_auditor
  ON audit_submissions (audit_id, submitted_by, status);

-- ── Split a shared submission into one per auditor ─────────────────────────
-- Every row keeps its counted_by, so the split is a fact already recorded on
-- the data, not a guess. The original submission keeps the auditor who
-- contributed the most rows; each other auditor gets a submission of their
-- own carrying the same submitted_at, because that is when the count was in
-- fact sent.
DO $$
DECLARE
  s        RECORD;
  a        RECORD;
  new_id   int;
  n_split  int := 0;
BEGIN
  FOR s IN
    SELECT sub.id, sub.audit_id, sub.submitted_at, sub.status, sub.is_demo, sub.submitted_by
      FROM audit_submissions sub
     WHERE EXISTS (
       SELECT 1 FROM submission_entries se
        WHERE se.submission_id = sub.id
        GROUP BY se.submission_id
       HAVING count(DISTINCT se.counted_by) > 1
     )
  LOOP
    -- Keep the largest contributor on the original row.
    SELECT counted_by INTO a
      FROM submission_entries WHERE submission_id = s.id
     GROUP BY counted_by ORDER BY count(*) DESC, counted_by LIMIT 1;

    UPDATE audit_submissions SET submitted_by = a.counted_by WHERE id = s.id;

    FOR a IN
      SELECT DISTINCT counted_by FROM submission_entries
       WHERE submission_id = s.id
         AND counted_by IS DISTINCT FROM (SELECT submitted_by FROM audit_submissions WHERE id = s.id)
    LOOP
      INSERT INTO audit_submissions
        (audit_id, submitted_by, submitted_at, entry_count, item_count, status, is_demo)
      VALUES (s.audit_id, a.counted_by, s.submitted_at, 0, 0, s.status, s.is_demo)
      RETURNING id INTO new_id;

      UPDATE submission_entries SET submission_id = new_id
       WHERE submission_id = s.id AND counted_by = a.counted_by;

      n_split := n_split + 1;
    END LOOP;
  END LOOP;

  IF n_split > 0 THEN
    RAISE NOTICE 'Split % shared submission(s) into per-auditor submissions.', n_split;
  ELSE
    RAISE NOTICE 'No shared submissions to split.';
  END IF;
END $$;

-- Counts are recomputed from the rows rather than carried over, so a split
-- submission reports what it actually holds.
UPDATE audit_submissions sub
   SET entry_count = COALESCE(x.n, 0), item_count = COALESCE(x.items, 0)
  FROM (SELECT submission_id, count(*) AS n, count(DISTINCT item_id) AS items
          FROM submission_entries GROUP BY submission_id) x
 WHERE x.submission_id = sub.id
   AND (sub.entry_count <> x.n OR sub.item_count <> x.items);

-- The auditor's own view filters every aggregate by who counted it, so this is
-- the index those queries run on.
CREATE INDEX IF NOT EXISTS idx_count_entries_auditor
  ON count_entries (audit_id, counted_by, item_id) WHERE status = 'active';
