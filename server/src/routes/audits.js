import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole, assertStoreAccess, loadAuditForUser } from '../middleware/auth.js';
import { forRole } from '../lib/blindCount.js';
import { itemEntriesForAdmin } from '../lib/reports.js';

const router = Router();
router.use(requireAuth);

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
  const { rows } = await query(
    `SELECT a.*, s.name AS store_name, s.code AS store_code
       FROM audits a JOIN stores s ON s.id = a.store_id
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

// Auditor submits the count. Variance stops being provisional at this point.
router.post('/:id/submit', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (audit.status !== 'open') return res.status(409).json({ error: `Audit is already ${audit.status}` });

  // Guard: every active item must be counted or explicitly marked N/A.
  const { rows: left } = await query(
    `SELECT count(*)::int AS n FROM items i
      WHERE i.is_active = TRUE
        AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.item_id=i.id AND ce.audit_id=$1 AND ce.status='active')
        AND NOT EXISTS (SELECT 1 FROM audit_na na WHERE na.item_id=i.id AND na.audit_id=$1)`,
    [req.params.id]
  );
  if (left[0].n > 0) {
    return res.status(409).json({ error: `${left[0].n} item(s) still uncounted`, uncounted: left[0].n });
  }
  const { rows } = await query(
    `UPDATE audits SET status='submitted', submitted_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  res.json(rows[0]);
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

// ── Section list with progress (M4) ──────────────────────────────────────────
router.get('/:id/sections', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const { rows } = await query(
    `WITH counted AS (
       SELECT i.section_id,
              COUNT(DISTINCT CASE WHEN ce.id IS NOT NULL OR na.id IS NOT NULL THEN i.id END) AS counted
         FROM items i
         LEFT JOIN count_entries ce ON ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active'
         LEFT JOIN audit_na na ON na.item_id = i.id AND na.audit_id = $1
        WHERE i.is_active = TRUE
        GROUP BY i.section_id
     ),
     totals AS (
       SELECT section_id, COUNT(*) AS total FROM items WHERE is_active = TRUE GROUP BY section_id
     )
     SELECT s.id, s.name, s.sort_order,
            COALESCE(t.total, 0)::int AS total,
            COALESCE(c.counted, 0)::int AS counted
       FROM sections s
       LEFT JOIN totals t ON t.section_id = s.id
       LEFT JOIN counted c ON c.section_id = s.id
      WHERE s.is_active = TRUE
      ORDER BY s.sort_order, s.name`,
    [req.params.id]
  );
  res.json(rows);
});

// ── Item list for an audit (M5) — blind-count filtered ───────────────────────
router.get('/:id/items', async (req, res) => {
  const { audit, allowed } = await loadAuditForUser(req.user, req.params.id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const { section_id, category_id, search, status } = req.query;
  const conds = ['i.is_active = TRUE'];
  const params = [req.params.id];
  if (section_id) { params.push(section_id); conds.push(`i.section_id = $${params.length}`); }
  if (category_id) { params.push(category_id); conds.push(`i.category_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conds.push(`i.name ILIKE $${params.length}`); }

  const { rows } = await query(
    `SELECT i.id, i.name, i.unit, i.is_liquor, i.bottle_size_ml,
            i.photo_url, i.photo_version, i.section_id, i.category_id, i.rate,
            COALESCE(agg.entry_count, 0)::int AS entry_count,
            agg.total_qty,
            agg.total_bottles,
            agg.total_open_ml,
            (na.id IS NOT NULL) AS not_applicable,
            na.reason AS na_reason
       FROM items i
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS entry_count,
                SUM(qty) AS total_qty,
                SUM(bottles) AS total_bottles,
                SUM(open_ml) AS total_open_ml
           FROM count_entries ce
          WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active'
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
    `SELECT i.id, i.name, i.unit, i.section_id
       FROM items i
      WHERE i.is_active = TRUE
        AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.item_id=i.id AND ce.audit_id=$1 AND ce.status='active')
        AND NOT EXISTS (SELECT 1 FROM audit_na na WHERE na.item_id=i.id AND na.audit_id=$1)
      ORDER BY i.name`,
    [req.params.id]
  );
  res.json(forRole(req.user.role, rows));
});

export default router;
