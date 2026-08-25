// ═══════════════════════════════════════════════════════════════════════════
// Which set of numbers a report is reading.
//
// There are two records of a count and they are deliberately not the same
// thing:
//
//   count_entries       the AUDITOR's working record. Append-only, voids and
//                       all. The admin side never writes to it and clearing
//                       submitted data never touches it.
//   submission_entries  a frozen copy of the active entries at the moment the
//                       auditor pressed Submit. This is what reports read.
//
// So an admin can clear what was submitted, the auditor's work survives
// untouched, and they can submit again.
// ═══════════════════════════════════════════════════════════════════════════
import { query } from '../db.js';

export const LIVE = 'live';          // reading count_entries — count in progress
export const SNAPSHOT = 'snapshot';  // reading submission_entries
export const CLEARED = 'cleared';    // the admin cleared it; there is nothing to read

// Resolve by SUBMISSION, not by audit status.
//
// Clearing puts the audit back to `open` so the auditor can submit again — but
// the report must not then quietly fall back to the live entries and look as
// though nothing happened. What decides is whether a submission is standing:
//
//   an active submission          → read it
//   the last one was cleared      → say so, read nothing
//   neither                       → the count is in progress, read it live
export async function auditSource(auditId) {
  const { rows: auditRows } = await query(
    `SELECT a.*, s.name AS store_name, s.code AS store_code
       FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id = $1`,
    [auditId]
  );
  const audit = auditRows[0] || null;
  if (!audit) return { mode: LIVE, audit: null, submission: null, cleared: null };

  const { rows } = await query(
    `SELECT sub.*, su.name AS submitted_by_name, cu.name AS cleared_by_name
       FROM audit_submissions sub
       LEFT JOIN users su ON su.id = sub.submitted_by
       LEFT JOIN users cu ON cu.id = sub.cleared_by
      WHERE sub.audit_id = $1
      ORDER BY sub.submitted_at DESC, sub.id DESC`,
    [auditId]
  );
  const active = rows.find((r) => r.status === 'active') || null;
  if (active) return { mode: SNAPSHOT, audit, submission: active, cleared: null, history: rows };

  const latest = rows[0] || null;
  if (latest && latest.status === 'cleared') {
    return { mode: CLEARED, audit, submission: null, cleared: latest, history: rows };
  }
  return { mode: LIVE, audit, submission: null, cleared: null, history: rows };
}

// The sentence a report prints instead of a table when the data was cleared.
// Never an empty table: every item would read as a 100% shortage, which is a
// finding, not a blank.
export function clearedNotice(cleared) {
  if (!cleared) return null;
  const when = cleared.cleared_at
    ? new Date(cleared.cleared_at).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric' })
    : 'an earlier date';
  const who = cleared.cleared_by_name ? ` by ${cleared.cleared_by_name}` : '';
  return {
    cleared_at: cleared.cleared_at,
    cleared_by: cleared.cleared_by_name || null,
    submitted_at: cleared.submitted_at,
    entry_count: cleared.entry_count,
    item_count: cleared.item_count,
    message: `Submitted data was cleared on ${when}${who}. `
      + "The auditor's count is still available and can be submitted again.",
  };
}

// ── Taking the snapshot ────────────────────────────────────────────────────
// Called inside the submit transaction. Copies the ACTIVE entries only —
// a voided entry was withdrawn by the auditor and was never part of the count.
//
// count_entries is not read destructively and not modified: this is a pure
// INSERT ... SELECT. Re-submitting marks the previous submission `replaced`
// rather than deleting it, so a re-submit stays visible in the history.
export async function createSubmission(client, auditId, userId) {
  await client.query(
    `UPDATE audit_submissions SET status='replaced'
      WHERE audit_id = $1 AND status = 'active'`,
    [auditId]
  );

  const { rows } = await client.query(
    `INSERT INTO audit_submissions
       (audit_id, submitted_by, entry_count, item_count, status, is_demo)
     SELECT $1, $2,
            (SELECT count(*) FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.status = 'active'),
            (SELECT count(DISTINCT ce.item_id) FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.status = 'active'),
            'active',
            (SELECT is_demo FROM audits WHERE id = $1)
     RETURNING *`,
    [auditId, userId]
  );
  const submission = rows[0];

  await client.query(
    `INSERT INTO submission_entries
       (submission_id, item_id, qty, bottles, open_ml, location_text, remarks,
        photo_url, counted_by, counted_at)
     SELECT $2, ce.item_id, ce.qty, ce.bottles, ce.open_ml, ce.location_text,
            ce.remarks, ce.photo_url, ce.counted_by, ce.counted_at
       FROM count_entries ce
      WHERE ce.audit_id = $1 AND ce.status = 'active'`,
    [auditId, submission.id]
  );
  return submission;
}

// ── Clearing it ────────────────────────────────────────────────────────────
// Deletes the snapshot ROWS and marks the submission cleared. It does not
// touch count_entries, photos, the item master or system stock — and the
// photo files stay in R2, because they belong to the count entry.
export async function clearSubmission(client, submission, userId) {
  const { rowCount } = await client.query(
    'DELETE FROM submission_entries WHERE submission_id = $1', [submission.id]
  );
  await client.query(
    `UPDATE audit_submissions
        SET status='cleared', cleared_by=$2, cleared_at=now()
      WHERE id = $1`,
    [submission.id, userId]
  );
  // Back to open so the auditor can submit again. Reports do NOT fall back to
  // the live entries — auditSource keys off the cleared submission, not this.
  await client.query(
    `UPDATE audits SET status='open', submitted_at=NULL, closed_at=NULL WHERE id=$1`,
    [submission.audit_id]
  );
  return rowCount;
}
