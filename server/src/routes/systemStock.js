import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects } from '../lib/csv.js';

const router = Router();
// ADMIN ONLY — system (book) stock is never exposed to auditors.
router.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/:auditId', async (req, res) => {
  const { rows } = await query(
    `SELECT ss.item_id, ss.qty, i.code, i.name, i.unit
       FROM system_stock ss JOIN items i ON i.id = ss.item_id
      WHERE ss.audit_id = $1 ORDER BY i.code`,
    [req.params.auditId]
  );
  res.json(rows);
});

// Bulk upsert system quantities. Accepts JSON rows [{code|item_id, qty}] or CSV.
router.post('/:auditId', upload.single('file'), async (req, res) => {
  let records = [];
  if (req.file) {
    const { records: r } = parseCsvObjects(req.file.buffer.toString('utf8'));
    records = r;
  } else if (Array.isArray(req.body?.rows)) {
    records = req.body.rows;
  } else {
    return res.status(400).json({ error: 'Provide CSV file or rows[]' });
  }

  const { rows: items } = await query('SELECT id, lower(code) AS code FROM items');
  const byCode = new Map(items.map((i) => [i.code, i.id]));

  const errors = [];
  const resolved = [];
  records.forEach((r, idx) => {
    let itemId = r.item_id ? parseInt(r.item_id, 10) : null;
    if (!itemId && r.code) itemId = byCode.get(String(r.code).toLowerCase());
    const qty = parseFloat(r.qty);
    if (!itemId) errors.push({ row: idx + 1, error: `unknown item ${r.code || r.item_id}` });
    else if (Number.isNaN(qty)) errors.push({ row: idx + 1, error: 'qty not a number' });
    else resolved.push({ itemId, qty });
  });
  if (errors.length) return res.status(400).json({ error: 'Import errors', errors });

  await withTransaction(async (c) => {
    for (const { itemId, qty } of resolved) {
      await c.query(
        `INSERT INTO system_stock (audit_id, item_id, qty, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (audit_id, item_id) DO UPDATE SET qty=EXCLUDED.qty, created_by=EXCLUDED.created_by, created_at=now()`,
        [req.params.auditId, itemId, qty, req.user.id]
      );
    }
  });
  res.json({ ok: true, count: resolved.length });
});

export default router;
