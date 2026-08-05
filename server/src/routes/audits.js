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
                             WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active')
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
                             WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status = 'active')
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
        AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.item_id=i.id AND ce.audit_id=$1 AND ce.status='active')
        AND NOT EXISTS (SELECT 1 FROM audit_na na WHERE na.item_id=i.id AND na.audit_id=$1)
      ORDER BY i.name`,
    [req.params.id]
  );
  res.json(forRole(req.user.role, rows));
});

export default router;
