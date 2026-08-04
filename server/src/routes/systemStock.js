import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { toCsv } from '../lib/csvTemplate.js';

const router = Router();
// ADMIN ONLY — system (book) stock is never exposed to the auditor role.
router.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Combined CSV template ───────────────────────────────────────────────────
// One template for both kinds of item: liquor columns are left blank on
// non-liquor rows. Matches exactly what the variance report needs.
router.get('/template', (_req, res) => {
  const csv = toCsv(
    ['item_name', 'system_qty', 'system_bottles', 'system_open_ml'],
    [
      ['Refined Oil', '24.5', '', ''],
      ['Paneer', '7.6', '', ''],
      ['Old Monk Rum', '', '3', '400'],
    ]
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="system_stock_template.csv"');
  res.send(csv);
});

// Current system stock for an audit, listed against the full active master so
// the admin can fill any item inline.
router.get('/:auditId', async (req, res) => {
  const { rows } = await query(
    `SELECT i.id AS item_id, i.name, i.unit, i.is_liquor, i.bottle_size_ml,
            ss.qty, ss.bottles, ss.open_ml,
            (ss.item_id IS NOT NULL) AS has_system
       FROM items i
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY i.name`,
    [req.params.auditId]
  );
  res.json(rows);
});

// Upsert a single item's system stock (manual inline edit).
router.put('/:auditId/item/:itemId', async (req, res) => {
  const b = req.body || {};
  const qty = b.qty === '' || b.qty == null ? null : Number(b.qty);
  const bottles = b.bottles === '' || b.bottles == null ? null : Number(b.bottles);
  const openMl = b.open_ml === '' || b.open_ml == null ? null : Number(b.open_ml);
  if ([qty, bottles, openMl].some((v) => v != null && Number.isNaN(v))) {
    return res.status(400).json({ error: 'Quantities must be numbers' });
  }
  const { rows } = await query(
    `INSERT INTO system_stock (audit_id, item_id, qty, bottles, open_ml, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (audit_id, item_id) DO UPDATE
       SET qty=EXCLUDED.qty, bottles=EXCLUDED.bottles, open_ml=EXCLUDED.open_ml,
           created_by=EXCLUDED.created_by, created_at=now()
     RETURNING *`,
    [req.params.auditId, req.params.itemId, qty, bottles, openMl, req.user.id]
  );
  res.json(rows[0]);
});

// ── CSV analysis shared by preview and commit ───────────────────────────────
async function analyse(records) {
  const { rows: items } = await query(
    'SELECT id, name, is_liquor FROM items WHERE is_active = TRUE');
  const byName = new Map(items.map((i) => [nameKey(i.name), i]));

  const matched = [];
  const unmatched = [];
  const invalid = [];
  const seen = new Set();

  records.forEach((r, idx) => {
    const row = idx + 2;
    const name = normalizeName(r.item_name ?? r.name);
    if (!name) { invalid.push({ row, name: '', error: 'item_name is required' }); return; }
    const key = nameKey(name);
    if (seen.has(key)) { invalid.push({ row, name, error: 'duplicate name within file' }); return; }
    seen.add(key);

    const item = byName.get(key);
    if (!item) { unmatched.push({ row, name }); return; }

    const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
    const qty = num(r.system_qty);
    const bottles = num(r.system_bottles);
    const openMl = num(r.system_open_ml);
    if ([qty, bottles, openMl].some((v) => v != null && Number.isNaN(v))) {
      invalid.push({ row, name, error: 'quantities must be numbers' }); return;
    }
    if (item.is_liquor && qty != null && bottles == null && openMl == null) {
      invalid.push({ row, name, error: 'liquor item: use system_bottles / system_open_ml' }); return;
    }
    if (!item.is_liquor && qty == null && (bottles != null || openMl != null)) {
      invalid.push({ row, name, error: 'non-liquor item: use system_qty' }); return;
    }
    matched.push({
      row, name, item_id: item.id, is_liquor: item.is_liquor,
      qty: item.is_liquor ? null : qty,
      bottles: item.is_liquor ? (bottles ?? 0) : null,
      open_ml: item.is_liquor ? (openMl ?? 0) : null,
    });
  });
  return { matched, unmatched, invalid };
}

// Preview: matched / unmatched counts before anything is written. Unmatched
// names are listed explicitly, never silently ignored.
router.post('/:auditId/preview', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { headers, records } = parseCsvObjects(text);
  if (!headers.includes('item_name')) {
    return res.status(400).json({ error: 'Missing required column: item_name' });
  }
  const { matched, unmatched, invalid } = await analyse(records);
  const { rows: existing } = await query(
    'SELECT count(*)::int AS n FROM system_stock WHERE audit_id = $1', [req.params.auditId]);
  res.json({
    total: records.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    invalidCount: invalid.length,
    matched, unmatched, invalid,
    // The client uses this to warn that committing REPLACES existing data.
    existingCount: existing[0].n,
  });
});

// Commit: a re-import REPLACES all system stock for the audit (the client
// confirms first — see the confirmation prompt on the admin screen).
router.post('/:auditId/commit', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { records } = parseCsvObjects(text);
  const { matched, invalid } = await analyse(records);
  if (invalid.length) return res.status(400).json({ error: 'Fix invalid rows before committing', invalid });

  await withTransaction(async (c) => {
    await c.query('DELETE FROM system_stock WHERE audit_id = $1', [req.params.auditId]);
    for (const m of matched) {
      await c.query(
        `INSERT INTO system_stock (audit_id, item_id, qty, bottles, open_ml, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.auditId, m.item_id, m.qty, m.bottles, m.open_ml, req.user.id]
      );
    }
  });
  res.json({ ok: true, imported: matched.length, replaced: true });
});

export default router;
