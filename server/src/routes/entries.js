import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { normalizeName } from '../lib/itemName.js';
import { logActivity } from '../lib/activityLog.js';
import { resolveLocation } from '../lib/locations.js';
import { requireAuth, loadAuditForUser } from '../middleware/auth.js';
import { forRole } from '../lib/blindCount.js';

const router = Router();
router.use(requireAuth);

// A client reference is generated on the phone: letters, digits, - and _.
const CLIENT_REF = /^[A-Za-z0-9_-]{8,64}$/;

async function findByClientRef(userId, clientRef) {
  const { rows } = await query(
    `SELECT ce.*, b.batch_no FROM count_entries ce
       LEFT JOIN item_batches b ON b.id = ce.batch_id
      WHERE ce.counted_by = $1 AND ce.client_ref = $2`,
    [userId, clientRef]
  );
  return rows[0] || null;
}

// ── A batch the counter found that the stock list does not have ─────────────
// Matched on the batch number within the article, case- and space-insensitive,
// so two counters typing "b-12" and "B-12 " get the SAME batch rather than
// two. The insert is ON CONFLICT DO NOTHING, which makes it safe against two
// phones creating the same batch at the same moment.
//
// It is permanent: an ordinary batch of the article from now on, available to
// every counter and every later audit. `origin = 'counted'` and who / which
// audit created it are kept so the admin can find it.
async function findOrCreateBatch(c, { item, batchNo, unit, userId, auditId }) {
  const ownUnit = String(unit ?? '').trim();
  const storedUnit = ownUnit && ownUnit.toLowerCase() !== String(item.unit || '').trim().toLowerCase()
    ? ownUnit : null;
  const { rows: created } = await c.query(
    `INSERT INTO item_batches (item_id, batch_no, unit, origin, created_by, created_in_audit)
     VALUES ($1,$2,$3,'counted',$4,$5)
     ON CONFLICT (item_id, lower(btrim(batch_no))) DO NOTHING
     RETURNING id`,
    [item.id, batchNo, storedUnit, userId, auditId]
  );
  if (created[0]) {
    await logActivity({
      auditId, entityType: 'item_batch', entityId: created[0].id, action: 'create_while_counting',
      recordCount: 1, detail: { article: item.name, batch_no: batchNo, unit: storedUnit || item.unit },
      userId,
    }, c);
    return { id: created[0].id, outcome: 'created' };
  }
  const { rows: found } = await c.query(
    `SELECT id, is_active FROM item_batches
      WHERE item_id = $1 AND lower(btrim(batch_no)) = lower(btrim($2))`,
    [item.id, batchNo]
  );
  const batch = found[0];
  // A batch that was retired but is physically on the shelf again is put
  // back into use — the count is the evidence that it exists.
  if (!batch.is_active) {
    await c.query('UPDATE item_batches SET is_active = TRUE, updated_at = now() WHERE id = $1', [batch.id]);
    await logActivity({
      auditId, entityType: 'item_batch', entityId: batch.id, action: 'reactivate_while_counting',
      recordCount: 1, detail: { article: item.name, batch_no: batchNo }, userId,
    }, c);
    return { id: batch.id, outcome: 'reactivated' };
  }
  return { id: batch.id, outcome: 'existing' };
}

// ── Prior entries for one item in an audit (M6 bottom sheet) ─────────────────
// Returns active + void rows. Void rows stay visible (struck through in UI).
router.get('/audits/:auditId/items/:itemId/entries', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  // "Already counted" on the entry sheet is the AUDITOR'S OWN entries. They
  // never see a colleague's count of the same item — that is the point of the
  // per-auditor model, and it is enforced in the query rather than hidden in
  // the client. An admin sees every entry, which is how a total is verified.
  // ?batch_id= narrows the sheet to one batch (warehouse). Without it every
  // entry for the article comes back, which is what the cafe has always read.
  const batchId = /^\d+$/.test(String(req.query.batch_id || '')) ? Number(req.query.batch_id) : null;
  const { rows } = await query(
    `SELECT ce.*, u.name AS counted_by_name, vu.name AS voided_by_name,
            b.batch_no
       FROM count_entries ce
       JOIN users u ON u.id = ce.counted_by
       LEFT JOIN users vu ON vu.id = ce.voided_by
       LEFT JOIN item_batches b ON b.id = ce.batch_id
      WHERE ce.audit_id = $1 AND ce.item_id = $2
        AND ($3::int IS NULL OR ce.counted_by = $3)
        AND ($4::int IS NULL OR ce.batch_id = $4)
      ORDER BY ce.counted_at ASC`,
    [req.params.auditId, req.params.itemId,
     req.user.role === 'admin' ? null : req.user.id, batchId]
  );
  res.json(forRole(req.user.role, rows));
});

// ── Batches of one article (warehouse) ──────────────────────────────────────
// Every active batch with what has been counted against it so far — the
// auditor's OWN count, the same per-auditor rule as the entry sheet.
//
// `stock_qty` is the batch's book quantity. The warehouse counter is meant to
// see it, so they can compare system and physical stock while counting. The
// cafe runs a BLIND count, so for a cafe store's audit it never reaches an
// auditor: it is dropped here, not hidden in the client.
router.get('/audits/:auditId/items/:itemId/batches', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (!/^\d+$/.test(String(req.params.itemId))) return res.status(400).json({ error: 'Invalid item' });

  const { rows } = await query(
    `SELECT b.id, b.item_id, b.batch_no, b.origin, b.is_active,
            to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            COALESCE(NULLIF(btrim(b.unit), ''), i.unit) AS unit,
            -- A retired batch has no book stock any more (same rule as the reports).
            CASE WHEN b.is_active THEN b.qty END AS stock_qty,
            COALESCE(agg.entry_count, 0)::int AS entry_count,
            agg.total_qty, agg.total_bottles, agg.total_open_ml,
            COALESCE(agg.void_count, 0)::int AS void_count
       FROM item_batches b
       JOIN items i ON i.id = b.item_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE ce.status = 'active') AS entry_count,
                SUM(ce.qty)     FILTER (WHERE ce.status = 'active') AS total_qty,
                SUM(ce.bottles) FILTER (WHERE ce.status = 'active') AS total_bottles,
                SUM(ce.open_ml) FILTER (WHERE ce.status = 'active') AS total_open_ml,
                COUNT(*) FILTER (WHERE ce.status = 'void') AS void_count
           FROM count_entries ce
          WHERE ce.batch_id = b.id AND ce.audit_id = $1
            AND ($3::int IS NULL OR ce.counted_by = $3)
       ) agg ON TRUE
      -- Live batches, plus any batch retired since that already has a count
      -- in this audit (by this auditor, or anyone for an admin), so the
      -- material's total on this sheet always includes everything counted.
      WHERE b.item_id = $2
        AND (b.is_active OR EXISTS (
              SELECT 1 FROM count_entries x
               WHERE x.batch_id = b.id AND x.audit_id = $1 AND x.status = 'active'
                 AND ($3::int IS NULL OR x.counted_by = $3)))
      -- Batches created during counting come last, under the stock list's own.
      ORDER BY b.is_active DESC, (b.origin = 'counted'), b.expiry_date NULLS LAST, lower(b.batch_no)`,
    [req.params.auditId, req.params.itemId,
     req.user.role === 'admin' ? null : req.user.id]
  );
  const showStock = req.user.role === 'admin' || audit.inventory_mode === 'warehouse';
  const out = rows.map((r) => {
    const counted = r.entry_count > 0;
    const row = { ...r, counted };
    if (!showStock) delete row.stock_qty;
    return row;
  });
  res.json(forRole(req.user.role, out));
});

// ── Create entry (APPEND-ONLY). Never overwrites; always a new row. ──────────
router.post('/audits/:auditId/entries', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body || {};

  // ── Idempotency ────────────────────────────────────────────────────────
  // The phone stamps every save with a reference. A retry of a save that
  // already landed — the reply was lost, so it was queued and sent again —
  // returns the entry that exists instead of creating a second one. This is
  // checked BEFORE the audit-status check: a retry arriving after the audit
  // was submitted must still be recognised as already saved, not refused and
  // parked as a lost count.
  const clientRef = b.client_ref == null || b.client_ref === '' ? null : String(b.client_ref);
  if (clientRef !== null && !CLIENT_REF.test(clientRef)) {
    return res.status(400).json({ error: 'Invalid client_ref' });
  }
  if (clientRef) {
    const existing = await findByClientRef(req.user.id, clientRef);
    // The same save already landed — but if the auditor has since VOIDED it,
    // answering "already saved" would be a lie: the entry on screen is gone
    // and nothing new is recorded. Refuse plainly instead, so the phone can
    // save it again as a new entry (it changes the reference to do so), and
    // a stale queued retry is parked where the auditor can see it rather
    // than silently resurrecting a count they withdrew.
    if (existing && existing.status === 'void') {
      return res.status(409).json({
        code: 'voided_duplicate',
        error: 'This entry was saved earlier and then voided, so it was not saved again. Tap SAVE again to record it as a new entry.',
      });
    }
    if (existing) {
      return res.status(200).json({ ...forRole(req.user.role, existing), duplicate: true });
    }
  }

  if (audit.status !== 'open') return res.status(409).json({ error: 'Audit is closed' });

  const itemId = b.item_id;
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  // Location is MANDATORY and must be a live entry in the global list. The UI
  // keeps Save disabled without one; this is the half that cannot be bypassed,
  // and it is what makes the report's location columns trustworthy.
  //
  // A WAREHOUSE store types its location instead — a rack, bin or godown
  // ("A-12", "Godown 2") that no fixed list could hold. It is just as
  // mandatory: blank is refused here, whatever the phone did.
  let loc;
  if (audit.inventory_mode === 'warehouse') {
    const typed = String(b.location_text ?? '').replace(/\s+/g, ' ').trim();
    if (typed) {
      if (typed.length > 100) return res.status(400).json({ error: 'Location is too long (100 characters at most)' });
      loc = { location: { id: null, name: typed } };
    } else if (b.location_id != null && b.location_id !== '') {
      loc = await resolveLocation(b.location_id);
    } else {
      return res.status(400).json({ error: 'Location is required — type where this stock was found' });
    }
  } else {
    loc = await resolveLocation(b.location_id);
  }
  if (loc.error) return res.status(400).json({ error: loc.error });

  const { rows: itemRows } = await query('SELECT * FROM items WHERE id = $1 AND is_active = TRUE', [itemId]);
  const item = itemRows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });
  // A cafe item is not counted in a warehouse audit, nor the other way round.
  if (item.inventory_mode !== audit.inventory_mode) {
    return res.status(400).json({ error: `"${item.name}" is not part of this store's ${audit.inventory_mode === 'warehouse' ? 'stock list' : 'item master'}` });
  }

  // ── Batch ──────────────────────────────────────────────────────────────
  // Either an existing batch (batch_id), or a NEW one the counter has just
  // created (new_batch_no). A batch must belong to this article and still be
  // live. In warehouse mode an article that HAS batches must be counted
  // against one of them — an article-level figure could not be reconciled
  // with any batch's book stock. The cafe never sends a batch and never has
  // one required.
  let batchId = null;
  const newBatchNo = normalizeName(b.new_batch_no);
  if (b.batch_id !== undefined && b.batch_id !== null && b.batch_id !== '') {
    if (!/^\d+$/.test(String(b.batch_id))) return res.status(400).json({ error: 'Invalid batch' });
    const { rows: br } = await query(
      'SELECT id, item_id, batch_no, is_active FROM item_batches WHERE id = $1', [b.batch_id]
    );
    const batch = br[0];
    if (!batch || String(batch.item_id) !== String(item.id)) {
      return res.status(400).json({ error: 'That batch does not belong to this article' });
    }
    if (!batch.is_active) {
      return res.status(400).json({ error: `Batch "${batch.batch_no}" is no longer in use` });
    }
    batchId = batch.id;
  } else if (newBatchNo) {
    if (audit.inventory_mode !== 'warehouse') {
      return res.status(400).json({ error: 'This store is not counted by batch' });
    }
    if (newBatchNo.length > 64) return res.status(400).json({ error: 'Batch number is too long (64 characters at most)' });
  } else if (audit.inventory_mode === 'warehouse') {
    const { rows: has } = await query(
      'SELECT 1 FROM item_batches WHERE item_id = $1 AND is_active LIMIT 1', [item.id]
    );
    if (has.length) return res.status(400).json({ error: 'Choose a batch for this article' });
  }

  let qty = null, bottles = null, openMl = null;
  if (item.is_liquor) {
    // Liquor: sealed bottles + open ml are SEPARATE. At least one must be an
    // explicit number (ZERO IS NOT BLANK — 0 is a valid explicit count).
    const hasBottles = b.bottles !== undefined && b.bottles !== null && b.bottles !== '';
    const hasOpen = b.open_ml !== undefined && b.open_ml !== null && b.open_ml !== '';
    if (!hasBottles && !hasOpen) {
      return res.status(400).json({ error: 'Enter sealed bottles and/or open ml (0 is allowed)' });
    }
    bottles = hasBottles ? parseInt(b.bottles, 10) : 0;
    openMl = hasOpen ? parseInt(b.open_ml, 10) : 0;
    if (Number.isNaN(bottles) || Number.isNaN(openMl) || bottles < 0 || openMl < 0) {
      return res.status(400).json({ error: 'Bottles / ml must be non-negative numbers' });
    }
  } else {
    // Non-liquor: qty must be present explicitly. 0 is allowed; blank is not.
    if (b.qty === undefined || b.qty === null || b.qty === '') {
      return res.status(400).json({ error: 'Quantity is required (type 0 if none found)' });
    }
    qty = parseFloat(b.qty);
    if (Number.isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Quantity must be a non-negative number' });
  }

  // The new batch and the entry are written in ONE transaction: a batch is
  // never created without the count that created it, and a count is never
  // saved against a batch that failed to be created.
  const result = await withTransaction(async (c) => {
    let batchOutcome = null;
    if (newBatchNo) {
      const r = await findOrCreateBatch(c, {
        item, batchNo: newBatchNo, unit: b.new_batch_unit, userId: req.user.id,
        auditId: Number(req.params.auditId),
      });
      batchId = r.id;
      batchOutcome = r.outcome;
    }
    const { rows } = await c.query(
      `INSERT INTO count_entries
         (audit_id, item_id, qty, bottles, open_ml, location_id, location_text,
          remarks, photo_url, counted_by, batch_id, client_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (counted_by, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      // location_text is written from the chosen location's name, so the audit
      // trail still records the words, and old rows stay readable alongside new
      // ones without a special case.
      [req.params.auditId, itemId, qty, bottles, openMl, loc.location.id, loc.location.name,
       b.remarks || null, b.photo_url || null, req.user.id, batchId, clientRef]
    );
    return { entry: rows[0] || null, batchOutcome };
  });

  // Lost a race with an identical retry: that one saved it.
  if (!result.entry) {
    const existing = await findByClientRef(req.user.id, clientRef);
    return res.status(200).json({ ...forRole(req.user.role, existing), duplicate: true });
  }
  const entry = result.entry;

  // ── Photo flow to item master ──────────────────────────────────────────
  // The entry photo stays attached to the entry as evidence either way; the
  // logic below only decides whether it also becomes the MASTER photo.
  let photoOutcome = null;
  if (b.photo_url) {
    if (!item.photo_url) {
      // No master photo yet → promote immediately, visible to everyone at once.
      await query(
        'UPDATE items SET photo_url = $2, photo_version = photo_version + 1 WHERE id = $1',
        [itemId, b.photo_url]
      );
      photoOutcome = 'promoted';
    } else if (item.photo_url !== b.photo_url) {
      // Master photo already exists → queue for admin approval, do not replace.
      await query(
        `INSERT INTO photo_reviews (item_id, entry_id, audit_id, proposed_url, current_url, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [itemId, entry.id, req.params.auditId, b.photo_url, item.photo_url, req.user.id]
      );
      photoOutcome = 'pending_review';
    }
  }

  // Counting an item clears any prior Not-Applicable mark for it.
  await query('DELETE FROM audit_na WHERE audit_id = $1 AND item_id = $2',
    [req.params.auditId, itemId]);

  res.status(201).json({ ...forRole(req.user.role, entry), photo_outcome: photoOutcome,
                         batch_outcome: result.batchOutcome });
});

// ── Void an entry (NO DELETION). Auditor may void own; admin may void any. ────
router.post('/entries/:id/void', async (req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A void reason is required' });

  const { rows: er } = await query('SELECT * FROM count_entries WHERE id = $1', [req.params.id]);
  const entry = er[0];
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const { audit, allowed } = await loadAuditForUser(req.user, entry.audit_id);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (audit.status !== 'open' && req.user.role !== 'admin') {
    return res.status(409).json({ error: 'Audit is closed' });
  }
  if (req.user.role !== 'admin' && entry.counted_by !== req.user.id) {
    return res.status(403).json({ error: 'You may only void your own entries' });
  }
  if (entry.status === 'void') return res.status(409).json({ error: 'Already voided' });

  const { rows } = await query(
    `UPDATE count_entries
       SET status='void', void_reason=$2, voided_by=$3, voided_at=now()
     WHERE id=$1 RETURNING *`,
    [req.params.id, reason, req.user.id]
  );
  res.json(forRole(req.user.role, rows[0]));
});

// ── Mark / unmark Not Applicable (M8 submit gate) ────────────────────────────
router.post('/audits/:auditId/na', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (audit.status !== 'open') return res.status(409).json({ error: 'Audit is closed' });

  const { item_id, reason } = req.body || {};
  if (!item_id || !(reason || '').trim()) {
    return res.status(400).json({ error: 'item_id and reason required' });
  }
  const { rows } = await query(
    `INSERT INTO audit_na (audit_id, item_id, reason, marked_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (audit_id, item_id) DO UPDATE SET reason=EXCLUDED.reason, marked_by=EXCLUDED.marked_by, marked_at=now()
     RETURNING *`,
    [req.params.auditId, item_id, reason.trim(), req.user.id]
  );
  res.status(201).json(rows[0]);
});

router.delete('/audits/:auditId/na/:itemId', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  await query('DELETE FROM audit_na WHERE audit_id=$1 AND item_id=$2',
    [req.params.auditId, req.params.itemId]);
  res.json({ ok: true });
});

export default router;
