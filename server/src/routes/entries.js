import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, loadAuditForUser } from '../middleware/auth.js';
import { forRole } from '../lib/blindCount.js';

const router = Router();
router.use(requireAuth);

// ── Prior entries for one item in an audit (M6 bottom sheet) ─────────────────
// Returns active + void rows. Void rows stay visible (struck through in UI).
router.get('/audits/:auditId/items/:itemId/entries', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await query(
    `SELECT ce.*, u.name AS counted_by_name, vu.name AS voided_by_name
       FROM count_entries ce
       JOIN users u ON u.id = ce.counted_by
       LEFT JOIN users vu ON vu.id = ce.voided_by
      WHERE ce.audit_id = $1 AND ce.item_id = $2
      ORDER BY ce.counted_at ASC`,
    [req.params.auditId, req.params.itemId]
  );
  res.json(forRole(req.user.role, rows));
});

// ── Create entry (APPEND-ONLY). Never overwrites; always a new row. ──────────
router.post('/audits/:auditId/entries', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (audit.status !== 'open') return res.status(409).json({ error: 'Audit is closed' });

  const b = req.body || {};
  const itemId = b.item_id;
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  const { rows: itemRows } = await query('SELECT * FROM items WHERE id = $1 AND is_active = TRUE', [itemId]);
  const item = itemRows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });

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

  const { rows } = await query(
    `INSERT INTO count_entries
       (audit_id, item_id, qty, bottles, open_ml, location_text, remarks, photo_url, counted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.params.auditId, itemId, qty, bottles, openMl,
     b.location_text || null, b.remarks || null, b.photo_url || null, req.user.id]
  );
  const entry = rows[0];

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

  res.status(201).json({ ...forRole(req.user.role, entry), photo_outcome: photoOutcome });
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
