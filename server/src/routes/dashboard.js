import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// D1 — live status of all outlets during a simultaneous count.
router.get('/', async (_req, res) => {
  const { rows } = await query(
    `WITH open_audits AS (
       SELECT a.id, a.store_id, s.name AS store_name, s.code AS store_code
         FROM audits a JOIN stores s ON s.id = a.store_id
        WHERE a.status = 'open'
     ),
     totals AS (SELECT COUNT(*)::int AS total FROM items WHERE is_active = TRUE),
     progress AS (
       SELECT oa.id AS audit_id,
              COUNT(DISTINCT ce.item_id) FILTER (WHERE ce.status='active')::int AS counted,
              MAX(ce.counted_at) AS last_entry
         FROM open_audits oa
         LEFT JOIN count_entries ce ON ce.audit_id = oa.id
        GROUP BY oa.id
     ),
     auditors AS (
       SELECT oa.id AS audit_id, COALESCE(string_agg(DISTINCT u.name, ', '), '') AS names
         FROM open_audits oa
         LEFT JOIN count_entries ce ON ce.audit_id = oa.id AND ce.status='active'
         LEFT JOIN users u ON u.id = ce.counted_by
        GROUP BY oa.id
     )
     SELECT oa.id AS audit_id, oa.store_name, oa.store_code,
            (SELECT total FROM totals) AS total,
            COALESCE(p.counted, 0) AS counted,
            p.last_entry,
            a.names AS auditors
       FROM open_audits oa
       LEFT JOIN progress p ON p.audit_id = oa.id
       LEFT JOIN auditors a ON a.audit_id = oa.id
       ORDER BY oa.store_name`
  );
  res.json(rows);
});

export default router;
