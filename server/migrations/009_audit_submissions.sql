-- ═══════════════════════════════════════════════════════════════════════════
-- Two-stage data model: the auditor's working record, and what was submitted.
--
-- Until now there was one table. Reports read count_entries directly, so any
-- admin-side clear would also destroy the auditor's counting. Submitting now
-- takes a SNAPSHOT, reports read the snapshot, and the admin can clear the
-- snapshot without touching a single count entry.
--
--   count_entries       the auditor's working record — append-only, voids and
--                       all. Never written to by the admin side.
--   submission_entries  a frozen copy of the ACTIVE entries at submit time.
--                       This is what the reports read.
--
-- A submission is never deleted, only marked, so "this was re-submitted" and
-- "the admin cleared this on the 6th" both stay visible.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_submissions (
  id            SERIAL PRIMARY KEY,
  audit_id      INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  submitted_by  INTEGER REFERENCES users(id),
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_count   INTEGER NOT NULL DEFAULT 0,
  item_count    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'cleared', 'replaced')),
  -- Who cleared it and when. The report that stands in place of a cleared
  -- table has to name them: "cleared on 6 Aug 2026 by Arvind".
  cleared_by    INTEGER REFERENCES users(id),
  cleared_at    TIMESTAMPTZ,
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE
);

-- At most one ACTIVE submission per audit. Re-submitting marks the previous
-- one 'replaced' first; cleared and replaced rows accumulate as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_submissions_active
  ON audit_submissions (audit_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_audit_submissions_audit
  ON audit_submissions (audit_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS submission_entries (
  id            SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES audit_submissions(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  qty           NUMERIC(14,3),
  bottles       INTEGER,
  open_ml       INTEGER,
  location_text TEXT,
  remarks       TEXT,
  -- The photo URL is copied so R6 can still report "counted but no photo" on a
  -- submitted audit. Clearing a submission deletes these ROWS only — the file
  -- in R2 belongs to the count entry and is never removed here.
  photo_url     TEXT,
  counted_by    INTEGER REFERENCES users(id),
  counted_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submission_entries_submission
  ON submission_entries (submission_id, item_id);

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Audits already submitted before this migration have no snapshot, and without
-- one their reports would read as "cleared" — a live audit would look wiped.
-- Give each one a submission built from its current active entries, so every
-- existing report renders exactly as it did yesterday.
INSERT INTO audit_submissions (audit_id, submitted_by, submitted_at, entry_count, item_count, status, is_demo)
SELECT a.id,
       (SELECT ce.counted_by FROM count_entries ce
         WHERE ce.audit_id = a.id AND ce.status = 'active'
         ORDER BY ce.counted_at DESC LIMIT 1),
       COALESCE(a.submitted_at, now()),
       (SELECT count(*) FROM count_entries ce
         WHERE ce.audit_id = a.id AND ce.status = 'active'),
       (SELECT count(DISTINCT ce.item_id) FROM count_entries ce
         WHERE ce.audit_id = a.id AND ce.status = 'active'),
       'active',
       a.is_demo
  FROM audits a
 WHERE a.status IN ('submitted', 'closed')
   AND NOT EXISTS (SELECT 1 FROM audit_submissions s WHERE s.audit_id = a.id);

INSERT INTO submission_entries
  (submission_id, item_id, qty, bottles, open_ml, location_text, remarks, photo_url, counted_by, counted_at)
SELECT s.id, ce.item_id, ce.qty, ce.bottles, ce.open_ml, ce.location_text, ce.remarks,
       ce.photo_url, ce.counted_by, ce.counted_at
  FROM audit_submissions s
  JOIN count_entries ce ON ce.audit_id = s.audit_id AND ce.status = 'active'
 WHERE s.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM submission_entries se WHERE se.submission_id = s.id);
