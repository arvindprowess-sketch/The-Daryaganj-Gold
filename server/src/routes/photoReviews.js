import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// Pending proposals: an auditor photographed an item that already had a master
// photo. The master is unchanged until an admin approves here.
router.get('/', async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows } = await query(
    `SELECT pr.id, pr.item_id, pr.proposed_url, pr.current_url, pr.status,
            pr.submitted_at, pr.reviewed_at,
            i.name AS item_name, i.unit, i.photo_version,
            u.name AS submitted_by_name,
            ru.name AS reviewed_by_name,
            a.audit_date, s.name AS store_name
       FROM photo_reviews pr
       JOIN items i ON i.id = pr.item_id
       JOIN users u ON u.id = pr.submitted_by
       LEFT JOIN users ru ON ru.id = pr.reviewed_by
       LEFT JOIN audits a ON a.id = pr.audit_id
       LEFT JOIN stores s ON s.id = a.store_id
      WHERE pr.status = $1
      ORDER BY pr.submitted_at DESC`,
    [status]
  );
  res.json(rows);
});

router.get('/count', async (_req, res) => {
  const { rows } = await query(
    `SELECT count(*)::int AS pending FROM photo_reviews WHERE status = 'pending'`);
  res.json(rows[0]);
});

// Approve — the proposed photo replaces the master. The count entry keeps its
// own photo_url untouched (evidence is never altered).
router.post('/:id/approve', async (req, res) => {
  const result = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM photo_reviews WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    const pr = rows[0];
    if (!pr) return null;
    await c.query(
      `UPDATE items SET photo_url = $2, photo_version = photo_version + 1 WHERE id = $1`,
      [pr.item_id, pr.proposed_url]);
    const { rows: updated } = await c.query(
      `UPDATE photo_reviews SET status='approved', reviewed_by=$2, reviewed_at=now()
        WHERE id=$1 RETURNING *`, [req.params.id, req.user.id]);
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'Not found or already reviewed' });
  res.json(result);
});

// Reject — master photo stays as it is. The entry photo remains attached to
// its count entry regardless.
router.post('/:id/reject', async (req, res) => {
  const { rows } = await query(
    `UPDATE photo_reviews SET status='rejected', reviewed_by=$2, reviewed_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found or already reviewed' });
  res.json(rows[0]);
});

export default router;
