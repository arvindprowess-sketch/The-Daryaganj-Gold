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
  // Mirrors the client's own system export so their file can be uploaded
  // as-is: LOC is ignored, the hierarchy columns only help identify unmatched
  // rows, and matching is on Item Name. system_bottles / system_open_ml are
  // optional extras for liquor, where bottles and ml stay separate.
  const csv = toCsv(
    ['LOC', 'Super Category Name', 'Category Name', 'Item Name', 'Unit', 'Closing Qty',
     'system_bottles', 'system_open_ml'],
    [
      ['M3M', 'FOOD', 'PROVISION', 'Refined Oil', 'CAN (5 LTR)', '24.5', '', ''],
      ['M3M', 'FOOD', 'DAIRY', 'Paneer', 'TIN (850 GM)', '7.6', '', ''],
      ['M3M', 'LIQUOR', 'LIQUOR', 'Old Monk Rum', 'BTL (750 ML)', '3', '3', '400'],
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
            COALESCE(sc.name,'—') AS super_category, COALESCE(c.name,'—') AS category,
            i.super_category_id, i.category_id,
            ss.qty, ss.bottles, ss.open_ml,
            (ss.item_id IS NOT NULL) AS has_system
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
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
// The client's own system export uses these headers:
//     LOC, Super Category Name, Category Name, Item Name, Unit, Closing Qty
// which the CSV parser lower-cases. Both that format and our own template are
// accepted. LOC is ignored; the hierarchy columns are carried through only to
// help identify unmatched rows in the preview — MATCHING IS ON ITEM NAME.
const pickName = (r) => r.item_name ?? r['item name'] ?? r.name;
const pickQty = (r) => r.system_qty ?? r['closing qty'] ?? r.closing_qty;
const pickSuper = (r) => r.super_category ?? r['super category name'] ?? r.super_category_name ?? '';
const pickCategory = (r) => r.category ?? r['category name'] ?? r.category_name ?? '';

async function analyse(records) {
  const { rows: items } = await query(
    'SELECT id, name, is_liquor FROM items WHERE is_active = TRUE');
  // Both sides are trimmed and internal double spaces collapsed before
  // comparing — the client's export contains trailing and doubled spaces and
  // those must never cause a false mismatch.
  const byName = new Map(items.map((i) => [nameKey(i.name), i]));

  const matched = [];
  const unmatched = [];
  const invalid = [];
  const seen = new Set();

  records.forEach((r, idx) => {
    const row = idx + 2;
    const name = normalizeName(pickName(r));
    if (!name) { invalid.push({ row, name: '', error: 'Item Name is required' }); return; }
    const key = nameKey(name);
    if (seen.has(key)) { invalid.push({ row, name, error: 'duplicate name within file' }); return; }
    seen.add(key);

    const item = byName.get(key);
    if (!item) {
      // Report the client's own hierarchy labels so an unmatched row is easy
      // to locate in their export.
      unmatched.push({
        row, name,
        super_category: normalizeName(pickSuper(r)),
        category: normalizeName(pickCategory(r)),
      });
      return;
    }

    const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
    const closing = num(pickQty(r));
    const bottles = num(r.system_bottles);
    const openMl = num(r.system_open_ml);
    if ([closing, bottles, openMl].some((v) => v != null && Number.isNaN(v))) {
      invalid.push({ row, name, error: 'quantities must be numbers' }); return;
    }

    if (item.is_liquor) {
      // Liquor keeps bottles and ml separate. Our own template supplies both
      // columns; the client's single Closing Qty column is the sealed-bottle
      // count, with open ml defaulting to 0 until entered.
      matched.push({
        row, name, item_id: item.id, is_liquor: true,
        qty: null,
        bottles: bottles ?? closing ?? 0,
        open_ml: openMl ?? 0,
      });
    } else {
      if (closing == null && (bottles != null || openMl != null)) {
        invalid.push({ row, name, error: 'non-liquor item: use system_qty / Closing Qty' }); return;
      }
      matched.push({
        row, name, item_id: item.id, is_liquor: false,
        qty: closing, bottles: null, open_ml: null,
      });
    }
  });
  return { matched, unmatched, invalid };
}

// Preview: matched / unmatched counts before anything is written. Unmatched
// names are listed explicitly, never silently ignored.
router.post('/:auditId/preview', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { headers, records } = parseCsvObjects(text);
  // Accept our template (item_name) or the client's export (Item Name).
  if (!headers.includes('item_name') && !headers.includes('item name') && !headers.includes('name')) {
    return res.status(400).json({ error: 'Missing required column: Item Name (or item_name)' });
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
