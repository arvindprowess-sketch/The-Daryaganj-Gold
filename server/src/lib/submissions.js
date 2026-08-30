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
//
// A submission belongs to ONE AUDITOR. Three auditors in a store each submit
// their own count, and the reports read the UNION of whatever is standing —
// so a second auditor submitting simply adds to what is already there, with
// nothing to merge, approve or refresh.
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
  if (!audit) return { mode: LIVE, audit: null, submissions: [], cleared: null, history: [] };

  const { rows } = await query(
    `SELECT sub.*, su.name AS submitted_by_name, su.username AS submitted_by_username,
            cu.name AS cleared_by_name
       FROM audit_submissions sub
       LEFT JOIN users su ON su.id = sub.submitted_by
       LEFT JOIN users cu ON cu.id = sub.cleared_by
      WHERE sub.audit_id = $1
      ORDER BY sub.submitted_at DESC, sub.id DESC`,
    [auditId]
  );

  // EVERY standing submission, not just one. This is what combines the
  // auditors: the reports read the union, so whoever has submitted so far is
  // exactly what the report shows, with no merge step anywhere.
  const active = rows.filter((r) => r.status === 'active');
  if (active.length) {
    return { mode: SNAPSHOT, audit, submissions: active, cleared: null, history: rows };
  }

  // Nothing standing. If the last thing that happened was a clear, say so
  // rather than falling back to the live entries as though it never happened.
  const cleared = rows.filter((r) => r.status === 'cleared');
  if (cleared.length) {
    return { mode: CLEARED, audit, submissions: [], cleared: cleared[0],
             clearedAll: cleared, history: rows };
  }
  return { mode: LIVE, audit, submissions: [], cleared: null, history: rows };
}

// The ids the report reads from, for a SQL `IN`.
export const submissionIds = (src) => (src.submissions || []).map((s) => s.id);

// The sentence a report prints instead of a table when the data was cleared.
// Never an empty table: every item would read as a 100% shortage, which is a
// finding, not a blank.
export function clearedNotice(cleared) {
  if (!cleared) return null;
  const whose = cleared.submitted_by_name ? `${cleared.submitted_by_name}'s ` : '';
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
    submitted_by: cleared.submitted_by_name || null,
    message: `${whose || 'Submitted '}data was cleared on ${when}${who}. `
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
  // Only THIS auditor's previous submission is replaced. Another auditor's
  // standing submission is untouched — one person submitting must never
  // disturb what a colleague has already sent.
  await client.query(
    `UPDATE audit_submissions SET status='replaced'
      WHERE audit_id = $1 AND submitted_by = $2 AND status = 'active'`,
    [auditId, userId]
  );

  const { rows } = await client.query(
    `INSERT INTO audit_submissions
       (audit_id, submitted_by, entry_count, item_count, status, is_demo)
     SELECT $1, $2,
            (SELECT count(*) FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.counted_by = $2 AND ce.status = 'active'),
            (SELECT count(DISTINCT ce.item_id) FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.counted_by = $2 AND ce.status = 'active'),
            'active',
            (SELECT is_demo FROM audits WHERE id = $1)
     RETURNING *`,
    [auditId, userId]
  );
  const submission = rows[0];

  // ...and only this auditor's entries are copied.
  await client.query(
    `INSERT INTO submission_entries
       (submission_id, item_id, qty, bottles, open_ml, location_id, location_text,
        remarks, photo_url, counted_by, counted_at)
     SELECT $3, ce.item_id, ce.qty, ce.bottles, ce.open_ml, ce.location_id,
            ce.location_text, ce.remarks, ce.photo_url, ce.counted_by, ce.counted_at
       FROM count_entries ce
      WHERE ce.audit_id = $1 AND ce.counted_by = $2 AND ce.status = 'active'`,
    [auditId, userId, submission.id]
  );
  return submission;
}

// The audit as a whole is submitted only when EVERY auditor mapped to the
// store has one standing. Until then it stays open, because somebody is still
// counting — and the reports say so with the PROVISIONAL stamp.
export async function refreshAuditStatus(client, auditId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS auditors,
            count(*) FILTER (WHERE sub.id IS NOT NULL)::int AS submitted
       FROM audits a
       JOIN user_stores us ON us.store_id = a.store_id
       JOIN users u ON u.id = us.user_id AND u.role = 'auditor' AND u.is_active
       LEFT JOIN audit_submissions sub
              ON sub.audit_id = a.id AND sub.submitted_by = u.id AND sub.status = 'active'
      WHERE a.id = $1`,
    [auditId]
  );
  const { auditors, submitted } = rows[0] || { auditors: 0, submitted: 0 };
  const complete = auditors > 0 && submitted === auditors;
  await client.query(
    `UPDATE audits
        SET status = CASE WHEN $2 THEN 'submitted' ELSE 'open' END,
            submitted_at = CASE WHEN $2 THEN COALESCE(submitted_at, now()) ELSE NULL END
      WHERE id = $1 AND status <> 'closed'`,
    [auditId, complete]
  );
  return { auditors, submitted, complete };
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
  // ONE auditor's rows leave the reports. Everyone else's standing submission
  // is untouched, and the reports recalculate from what remains on the next
  // read — there is nothing to refresh.
  //
  // The audit reopens because this auditor now has nothing standing, which is
  // what lets them submit again.
  await client.query(
    `UPDATE audits SET status='open', submitted_at=NULL WHERE id=$1 AND status='submitted'`,
    [submission.audit_id]
  );
  return rowCount;
}
