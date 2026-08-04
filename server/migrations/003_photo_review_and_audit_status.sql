-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Photo flow from counting → item master, with approval protection.
--    If an item has NO master photo the auditor's photo is promoted at once.
--    If it HAS one, the new photo is queued here for admin approval and the
--    master is left untouched. The entry photo itself is evidence and is
--    NEVER deleted or replaced — this table only proposes a master change.
--
-- 2. Audit gains a 'submitted' status so variance can stop being provisional.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS photo_reviews (
  id             SERIAL PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  entry_id       INTEGER REFERENCES count_entries(id) ON DELETE SET NULL,
  audit_id       INTEGER REFERENCES audits(id) ON DELETE CASCADE,
  proposed_url   TEXT NOT NULL,
  current_url    TEXT,                    -- master photo at time of proposal
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by   INTEGER NOT NULL REFERENCES users(id),
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_photo_reviews_pending
  ON photo_reviews (status) WHERE status = 'pending';

-- Bump this when the master photo changes so clients can cache-bust the URL.
ALTER TABLE items ADD COLUMN IF NOT EXISTS photo_version INTEGER NOT NULL DEFAULT 1;

-- Allow the 'submitted' state between open and closed.
ALTER TABLE audits DROP CONSTRAINT IF EXISTS audits_status_check;
ALTER TABLE audits ADD CONSTRAINT audits_status_check
  CHECK (status IN ('open', 'submitted', 'closed'));

ALTER TABLE audits ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

-- System stock keeps liquor bottles and open ml SEPARATE, matching how the
-- physical count is recorded. qty remains for non-liquor items.
ALTER TABLE system_stock ADD COLUMN IF NOT EXISTS bottles INTEGER;
ALTER TABLE system_stock ADD COLUMN IF NOT EXISTS open_ml INTEGER;
ALTER TABLE system_stock ALTER COLUMN qty DROP NOT NULL;
