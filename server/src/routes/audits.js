import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole, assertStoreAccess, loadAuditForUser } from '../middleware/auth.js';
import { forRole } from '../lib/blindCount.js';
import { itemEntriesForAdmin } from '../lib/reports.js';
import { auditSource, createSubmission, clearSubmission, clearedNotice,
         refreshAuditStatus, SNAPSHOT, CLEARED } from '../lib/submissions.js';
import { logActivity } from '../lib/activityLog.js';

const router = Router();
router.use(requireAuth);

// ── Whose count is this? ────────────────────────────────────────────────────
// An AUDITOR sees only their own entries: their own ticks, their own totals,
// their own progress. Three auditors in one store each start from a blank
// sheet and never see each other's work — combination happens in the admin
// portal after submission, never in an auditor's own view.
//
// An ADMIN sees everything, because verifying how a total was arrived at is
// the whole job of the admin screens.
//
// This is enforced HERE, in the query, not by filtering in the client: a
// client-side filter is a display choice, and this is an access rule.
const ownerFilter = (user, alias = 'ce') =>
  (user.role === 'admin' ? '' : ` AND ${alias}.counted_by = ${Number(user.id)}`);

// ── List audits ──────────────────────────────────────────────────────────────
// Admin: all (optionally by store). Auditor: only audits for assigned stores.
router.get('/', async (req, res) => {
  const { store_id, status } = req.query;
  const conds = [];
  const params = [];
  if (req.user.role !== 'admin') {
    params.push(req.user.id);
    conds.push(`a.store_id IN (SELECT store_id FROM user_stores WHERE user_id = $${params.length})`);
  }
  if (store_id) { params.push(store_id); conds.push(`a.store_id = $${params.length}`); }
  if (status) { params.push(status); conds.push(`a.status = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // The submission state travels with the audit, so the admin dashboard and
  // the auditor's store list read the same three words from one query rather
  // than each deciding for themselves what "submitted" means.
  //
  //   counting   nothing standing — the count is in progress
  //   submitted  a snapshot exists and the reports are reading it
  //   cleared    the admin cleared it; the auditor's count is still there
  const { rows } = await query(
    `SELECT a.*, s.name AS store_name, s.code AS store_code,
            sub.status AS submission_status, sub.submitted_at AS submission_at,
            sub.item_count AS submission_items, sub.entry_count AS submission_entries,
            sub.cleared_at, cu.name AS cleared_by_name, su.name AS submitted_by_name,
            -- What the auditor has in hand right now. A clear never touches
            -- this, so the auditor's screen can say "nothing was lost".
            (SELECT count(*)::int FROM count_entries ce
              WHERE ce.audit_id = a.id AND ce.status = 'active'
                    ${ownerFilter(req.user)}) AS live_entries,
            CASE WHEN sub.status = 'active' THEN 'submitted'
                 WHEN sub.status = 'cleared' THEN 'cleared'
                 ELSE 'counting' END AS session_state,
            -- The per-auditor panel: how many are mapped to this store and how
            -- many have something standing.
            (SELECT count(*)::int FROM user_stores us
               JOIN users u ON u.id = us.user_id AND u.role='auditor' AND u.is_active
              WHERE us.store_id = a.store_id) AS auditor_count,
            (SELECT count(*)::int FROM audit_submissions x
              WHERE x.audit_id = a.id AND x.status = 'active') AS submitted_count
       FROM audits a
       JOIN stores s ON s.id = a.store_id
       -- An AUDITOR's state is their OWN submission — whether a colleague has
       -- submitted says nothing about whether they still have work to send.
       -- An admin sees the audit's latest, whoever it belongs to.
       LEFT JOIN LATERAL (
         SELECT * FROM audit_submissions x
          WHERE x.audit_id = a.id
            ${req.user.role === 'admin' ? '' : `AND x.submitted_by = ${Number(req.user.id)}`}
          ORDER BY (x.status = 'active') DESC, x.submitted_at DESC, x.id DESC
          LIMIT 1
       ) sub ON TRUE
       LEFT JOIN users cu ON cu.id = sub.cleared_by
       LEFT JOIN users su ON su.id = sub.submitted_by
       ${where}
       ORDER BY a.audit_date DESC, a.id DESC`,
    params
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { store_id, audit_date, cutoff_time } = req.body || {};
  if (!store_id || !audit_date) return res.status(400).json({ error: 'store_id and audit_date required' });
  const { rows } = await query(
    `INSERT INTO audits (store_id, audit_date, cutoff_time, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [store_id, audit_date, cutoff_time || null, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// ── Submit summary ──────────────────────────────────────────────────────────
// The three figures the confirmation dialog states before an auditor commits.
// `counted` means the item has at least one active count entry — nothing else
// counts as counted.
async function submitSummary(auditId, userId) {
  // The auditor's OWN figures. What they are about to send is their own
  // count, so the confirmation dialog must state their own numbers.
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM items WHERE is_active) AS total,
            (SELECT count(DISTINCT ce.item_id)::int
               FROM count_entries ce JOIN items i ON i.id = ce.item_id
              WHERE ce.audit_id = $1 AND ce.status = 'active' AND i.is_active
                AND ($2::int IS NULL OR ce.counted_by = $2)) AS counted,
            (SELECT count(*)::int FROM audit_na WHERE audit_id = $1) AS not_applicable`,
    [auditId, userId ?? null]
  );
  const r = rows[0];
  return { ...r, uncounted: r.total - r.counted };
}

router.get('/:id/submit-summary', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  res.json(await submitSummary(req.params.id, req.user.role === 'admin' ? null : req.user.id));
});

// Auditor submits the count. Variance stops being provisional at this point.
//
// An uncounted item does NOT block submission. The item master is shared across
// every store while a single outlet stocks only a subset of it, so most
// uncounted items are simply not stocked here — making the auditor mark each
// one Not Applicable would be unworkable. The client states the numbers in a
// confirmation dialog instead.
//
// Submitting CREATES NOTHING and DELETES NOTHING: no zero-quantity entries for
// uncounted items, no automatic audit_na rows, and every existing entry, photo
// and audit record stays exactly as it is. Data is only ever removed by an
// admin through Data management.
router.post('/:id/submit', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (audit.status === 'closed') return res.status(409).json({ error: 'Audit is closed' });
  // Re-submitting is allowed and REPLACES this auditor's previous submission.
  // A colleague having submitted is irrelevant either way — their standing
  // submission is untouched.

  const summary = await submitSummary(req.params.id, req.user.id);

  // Submitting takes a SNAPSHOT. count_entries is copied, never moved: the
  // auditor keeps their working record and the reports get a frozen set of
  // numbers the admin can clear without destroying anyone's work.
  const result = await withTransaction(async (c) => {
    const submission = await createSubmission(c, req.params.id, req.user.id);
    // The audit becomes `submitted` only when EVERY auditor mapped to the
    // store has one standing. One person finishing does not close the store.
    const progress = await refreshAuditStatus(c, req.params.id);
    const { rows } = await c.query('SELECT * FROM audits WHERE id=$1', [req.params.id]);
    await logActivity({
      auditId: Number(req.params.id), entityType: 'audit_submission', entityId: submission.id,
      action: 'submit', recordCount: submission.entry_count,
      detail: { submission_id: submission.id, entries: submission.entry_count,
                items: submission.item_count,
                auditors_submitted: progress.submitted, auditors_total: progress.auditors },
      userId: req.user.id,
    }, c);
    return { audit: rows[0], submission, progress };
  });

  // The numbers as they stood at submission, so the auditor's confirmation
  // screen reports what was actually sent.
  res.json({ ...result.audit, summary, submission: result.submission,
             progress: result.progress });
});

// ── Submission state ────────────────────────────────────────────────────────
// One endpoint both sides read, so the auditor and the admin can never be
// looking at different accounts of whether the data exists.
//
//   not_submitted            nothing sent yet — counting
//   submitted                a snapshot is standing
//   cleared                  the admin cleared it; the count is still there
router.get('/:id/submission', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const src = await auditSource(req.params.id);
  const isAdmin = req.user.role === 'admin';
  // An auditor's state is their OWN submission. A colleague having submitted
  // says nothing about whether this auditor still has work to send.
  const mine = src.submissions.find((x) => String(x.submitted_by) === String(req.user.id)) || null;
  const myCleared = mine ? null
    : (src.history || []).find((h) => h.status === 'cleared'
        && String(h.submitted_by) === String(req.user.id)) || null;
  const state = mine ? 'submitted' : myCleared ? 'cleared' : 'not_submitted';

  // What is sitting in this auditor's working record right now, which is what
  // a re-submit would send. Unaffected by any clear.
  const { rows: live } = await query(
    `SELECT count(*)::int AS entries, count(DISTINCT item_id)::int AS items
       FROM count_entries
      WHERE audit_id = $1 AND status = 'active'
        AND ($2::int IS NULL OR counted_by = $2)`,
    [req.params.id, isAdmin ? null : req.user.id]
  );

  res.json({
    state,
    submission: mine,
    cleared: clearedNotice(myCleared),
    live: live[0],
    can_submit: live[0].entries > 0 && state !== 'submitted',
    // Everyone on this store and where they have got to. The admin panel
    // renders it; an auditor sees it too, because knowing a colleague has
    // finished is not the same as seeing their numbers.
    auditors: await auditorPanel(req.params.id),
    history: (src.history || []).map((h) => ({
      id: h.id, status: h.status, submitted_at: h.submitted_at,
      submitted_by: h.submitted_by, submitted_by_name: h.submitted_by_name,
      entry_count: h.entry_count, item_count: h.item_count,
      cleared_at: h.cleared_at, cleared_by_name: h.cleared_by_name,
    })),
  });
});

// ── Who is on this store, and where each of them has got to ─────────────────
// One row per auditor mapped to the store, whether or not they have started.
// This is the panel on the audit session screen:
//
//   Rakesh    412 items    Submitted 11:40 PM   [Clear]
//   Sunil     287 items    Submitted 11:52 PM   [Clear]
//   Chandan   103 items    Still counting
async function auditorPanel(auditId) {
  const { rows } = await query(
    `WITH participants AS (
       -- Everyone MAPPED to the store, so somebody who has not started still
       -- shows as "still counting" rather than being invisible...
       SELECT u.id, u.name, u.username, u.role, TRUE AS assigned
         FROM audits a
         JOIN user_stores us ON us.store_id = a.store_id
         JOIN users u ON u.id = us.user_id AND u.role = 'auditor' AND u.is_active
        WHERE a.id = $1
       UNION
       -- ...plus anyone who has actually COUNTED on this audit, whoever they
       -- are. An admin entering counts on the desktop grid belongs here: their
       -- entries reach no report until they are submitted, and leaving them
       -- off this panel is what made that invisible.
       SELECT u.id, u.name, u.username, u.role, FALSE
         FROM count_entries ce
         JOIN users u ON u.id = ce.counted_by
        WHERE ce.audit_id = $1 AND ce.status = 'active'
     )
     SELECT p.id AS user_id, p.name, p.username, p.role, bool_or(p.assigned) AS assigned,
            sub.id AS submission_id, sub.submitted_at, sub.entry_count, sub.item_count,
            (SELECT count(*)::int FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.counted_by = p.id AND ce.status='active') AS live_entries,
            (SELECT count(DISTINCT ce.item_id)::int FROM count_entries ce
              WHERE ce.audit_id = $1 AND ce.counted_by = p.id AND ce.status='active') AS live_items,
            cl.cleared_at, cu.name AS cleared_by_name
       FROM participants p
       LEFT JOIN audit_submissions sub
              ON sub.audit_id = $1 AND sub.submitted_by = p.id AND sub.status = 'active'
       LEFT JOIN LATERAL (
         SELECT * FROM audit_submissions x
          WHERE x.audit_id = $1 AND x.submitted_by = p.id AND x.status = 'cleared'
          ORDER BY x.cleared_at DESC LIMIT 1
       ) cl ON sub.id IS NULL
       LEFT JOIN users cu ON cu.id = cl.cleared_by
      GROUP BY p.id, p.name, p.username, p.role, sub.id, sub.submitted_at,
               sub.entry_count, sub.item_count, cl.cleared_at, cu.name
      ORDER BY p.name`,
    [auditId]
  );
  return rows.map((r) => ({
    ...r,
    state: r.submission_id ? 'submitted' : r.cleared_at ? 'cleared' : 'counting',
    // The figure that matters: counted, but in no standing submission, so in
    // no report. Silent data loss unless somebody is told.
    unsubmitted: r.submission_id ? 0 : Number(r.live_entries || 0),
  }));
}

// ── Clear submitted data — ADMIN ONLY ───────────────────────────────────────
// Removes what was SENT, not what was counted. The auditor's entries, the
// photos behind them, the item master and system stock are all untouched, and
// the audit reopens so the count can be submitted again.
const CLEAR_SUBMITTED = 'CLEAR SUBMITTED DATA';
const CLEAR_ALL = 'CLEAR ALL SUBMITTED DATA';

const when = (t) => new Date(t).toLocaleString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// Clearing is PER AUDITOR. The admin picks whose submission goes, and only
// that auditor's rows leave the reports — everyone else's stays exactly as it
// is, and the reports recalculate from what remains on the next read.
router.get('/:id/clear-submission/preview', requireRole('admin'), async (req, res) => {
  const src = await auditSource(req.params.id);
  if (!src.audit) return res.status(404).json({ error: 'Not found' });
  const userId = req.query.user_id;
  const target = userId
    ? src.submissions.find((x) => String(x.submitted_by) === String(userId))
    : src.submissions[0];
  if (!target) {
    return res.status(409).json({ error: 'There is no submitted data to clear for this auditor' });
  }
  // Naming who is NOT affected is the point: the admin has to be able to see
  // that clearing one auditor leaves the others alone.
  const others = src.submissions.filter((x) => x.id !== target.id);
  const whose = target.submitted_by_name || 'This auditor';
  const untouched = others.length
    ? ` ${others.map((o) => o.submitted_by_name).filter(Boolean).join(' and ')}'s submitted data is not affected.`
    : '';
  res.json({
    confirm_phrase: CLEAR_SUBMITTED,
    submission_id: target.id,
    user_id: target.submitted_by,
    auditor_name: target.submitted_by_name,
    store_name: src.audit.store_name,
    item_count: target.item_count, entry_count: target.entry_count,
    submitted_at: target.submitted_at,
    others: others.map((o) => ({ user_id: o.submitted_by, name: o.submitted_by_name })),
    message: `This removes ${whose}'s submitted data for ${src.audit.store_name} — `
      + `${target.item_count} items, submitted ${when(target.submitted_at)}.${untouched}`
      + ` ${whose}'s own count entries remain and can be submitted again.`,
  });
});

router.post('/:id/clear-submission', requireRole('admin'), async (req, res) => {
  if ((req.body?.confirm || '').trim().toUpperCase() !== CLEAR_SUBMITTED) {
    return res.status(400).json({ error: `Type "${CLEAR_SUBMITTED}" to confirm` });
  }
  const src = await auditSource(req.params.id);
  if (!src.audit) return res.status(404).json({ error: 'Not found' });
  const userId = req.body?.user_id;
  const target = userId
    ? src.submissions.find((x) => String(x.submitted_by) === String(userId))
    : src.submissions[0];
  if (!target) {
    return res.status(409).json({ error: 'There is no submitted data to clear for this auditor' });
  }

  const removed = await withTransaction(async (c) => {
    const n = await clearSubmission(c, target, req.user.id);
    await refreshAuditStatus(c, req.params.id);
    await logActivity({
      auditId: Number(req.params.id), entityType: 'audit_submission',
      entityId: target.id, action: 'clear_submission', recordCount: n,
      detail: { store: src.audit.store_name, rows: n, items: target.item_count,
                auditor: target.submitted_by_name, auditor_id: target.submitted_by,
                submitted_at: target.submitted_at },
      userId: req.user.id,
    }, c);
    return n;
  });

  res.json({ ok: true, removed, auditor: target.submitted_by_name,
             remaining: src.submissions.length - 1 });
});

// ── Clear EVERY auditor's submitted data ────────────────────────────────────
// A separate action with its own phrase, for resetting the whole store. It is
// deliberately not the default: clearing one auditor is the common case, and
// wiping every auditor's work should take a different sentence to type.
router.get('/:id/clear-all-submissions/preview', requireRole('admin'), async (req, res) => {
  const src = await auditSource(req.params.id);
  if (!src.audit) return res.status(404).json({ error: 'Not found' });
  if (!src.submissions.length) {
    return res.status(409).json({ error: 'There is no submitted data to clear for this audit' });
  }
  const names = src.submissions.map((x) => x.submitted_by_name).filter(Boolean);
  const items = src.submissions.reduce((t, x) => t + Number(x.item_count || 0), 0);
  res.json({
    confirm_phrase: CLEAR_ALL,
    store_name: src.audit.store_name,
    auditors: src.submissions.map((x) => ({
      user_id: x.submitted_by, name: x.submitted_by_name,
      item_count: x.item_count, submitted_at: x.submitted_at,
    })),
    message: `This removes the submitted data of ALL ${src.submissions.length} auditor(s) for `
      + `${src.audit.store_name} — ${names.join(', ')}, ${items} items in total. `
      + 'Every auditor\'s own count entries remain and can be submitted again.',
  });
});

router.post('/:id/clear-all-submissions', requireRole('admin'), async (req, res) => {
  if ((req.body?.confirm || '').trim().toUpperCase() !== CLEAR_ALL) {
    return res.status(400).json({ error: `Type "${CLEAR_ALL}" to confirm` });
  }
  const src = await auditSource(req.params.id);
  if (!src.audit) return res.status(404).json({ error: 'Not found' });
  if (!src.submissions.length) {
    return res.status(409).json({ error: 'There is no submitted data to clear for this audit' });
  }

  const removed = await withTransaction(async (c) => {
    let n = 0;
    for (const sub of src.submissions) n += await clearSubmission(c, sub, req.user.id);
    await refreshAuditStatus(c, req.params.id);
    await logActivity({
      auditId: Number(req.params.id), entityType: 'audit', entityId: Number(req.params.id),
      action: 'clear_all_submissions', recordCount: n,
      detail: { store: src.audit.store_name, rows: n,
                auditors: src.submissions.map((x) => x.submitted_by_name) },
      userId: req.user.id,
    }, c);
    return n;
  });

  res.json({ ok: true, removed, auditors: src.submissions.length });
});

// Admin working view: every individual entry per item, voided ones included.
// This is where an admin verifies how a total was arrived at. Client reports
// never show this level of detail.
router.get('/:id/entries', requireRole('admin'), async (req, res) => {
  const data = await itemEntriesForAdmin(req.params.id, req.query.item_id || null);
  res.json(data);
});

router.post('/:id/close', requireRole('admin'), async (req, res) => {
  const { rows } = await query(
    `UPDATE audits SET status='closed', closed_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.get('/:id', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await query(
    'SELECT name, code FROM stores WHERE id = $1', [audit.store_id]
  );
  res.json({ ...audit, store_name: rows[0]?.name, store_code: rows[0]?.code });
});

// ── Super category list with progress (M4) ───────────────────────────────────
// The auditor sees SUPER CATEGORIES ONLY — categories are never a navigation
// level on mobile. Progress is one aggregate query (no per-item round trips),
// so it stays cheap at 618 items per store.
router.get('/:id/super-categories', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const { rows } = await query(
    `SELECT sc.id, sc.name, sc.sort_order,
            COUNT(i.id)::int AS total,
            COUNT(i.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM count_entries ce
                             WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active'
                                   ${ownerFilter(req.user)})
                 OR EXISTS (SELECT 1 FROM audit_na na
                             WHERE na.item_id = i.id AND na.audit_id = $1)
            )::int AS counted
       FROM super_categories sc
       LEFT JOIN items i ON i.super_category_id = sc.id AND i.is_active = TRUE
      WHERE sc.is_active = TRUE
      GROUP BY sc.id, sc.name, sc.sort_order
      ORDER BY sc.sort_order, sc.name`,
    [req.params.id]
  );
  res.json(rows);
});

// Category-level progress (admin console only — never a mobile nav level).
router.get('/:id/categories', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const { rows } = await query(
    `SELECT c.id, c.name, c.super_category_id, sc.name AS super_category_name,
            COUNT(i.id)::int AS total,
            COUNT(i.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM count_entries ce
                             WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active'
                                   ${ownerFilter(req.user)})
                 OR EXISTS (SELECT 1 FROM audit_na na
                             WHERE na.item_id = i.id AND na.audit_id = $1)
            )::int AS counted
       FROM categories c
       LEFT JOIN super_categories sc ON sc.id = c.super_category_id
       LEFT JOIN items i ON i.category_id = c.id AND i.is_active = TRUE
      WHERE c.is_active = TRUE
      GROUP BY c.id, c.name, c.super_category_id, sc.name, sc.sort_order
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name`,
    [req.params.id]
  );
  res.json(rows);
});

// ── Item list for an audit (M5) — blind-count filtered ───────────────────────
router.get('/:id/items', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const { super_category_id, category_id, search, status } = req.query;
  const conds = ['i.is_active = TRUE'];
  const params = [req.params.id];
  if (super_category_id) { params.push(super_category_id); conds.push(`i.super_category_id = $${params.length}`); }
  if (category_id) { params.push(category_id); conds.push(`i.category_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conds.push(`i.name ILIKE $${params.length}`); }

  const { rows } = await query(
    `SELECT i.id, i.name, i.unit, i.is_liquor, i.bottle_size_ml,
            i.photo_url, i.photo_version, i.super_category_id, i.category_id, i.rate,
            sc.name AS super_category_name, c.name AS category_name,
            COALESCE(agg.entry_count, 0)::int AS entry_count,
            agg.total_qty,
            agg.total_bottles,
            agg.total_open_ml,
            (na.id IS NOT NULL) AS not_applicable,
            na.reason AS na_reason
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS entry_count,
                SUM(qty) AS total_qty,
                SUM(bottles) AS total_bottles,
                SUM(open_ml) AS total_open_ml
           FROM count_entries ce
          WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active'
                ${ownerFilter(req.user)}
       ) agg ON TRUE
       LEFT JOIN audit_na na ON na.item_id = i.id AND na.audit_id = $1
      WHERE ${conds.join(' AND ')}
      ORDER BY i.name`,
    params
  );

  let items = rows.map((r) => ({
    ...r,
    counted: r.entry_count > 0 || r.not_applicable,
  }));

  if (status === 'counted') items = items.filter((i) => i.counted);
  else if (status === 'notcounted') items = items.filter((i) => !i.counted);

  // Blind count: strips rate before it ever reaches an auditor.
  res.json(forRole(req.user.role, items));
});

// ── Submit readiness / uncounted list (M8) ───────────────────────────────────
router.get('/:id/uncounted', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await query(
    `SELECT i.id, i.name, i.unit, i.super_category_id
       FROM items i
      WHERE i.is_active = TRUE
        AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.item_id=i.id AND ce.audit_id=$1 AND ce.status='active'
                                ${ownerFilter(req.user)})
        AND NOT EXISTS (SELECT 1 FROM audit_na na WHERE na.item_id=i.id AND na.audit_id=$1)
      ORDER BY i.name`,
    [req.params.id]
  );
  res.json(forRole(req.user.role, rows));
});

export default router;
