import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { readCsvUpload } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { toCsv } from '../lib/csvTemplate.js';
import { logActivity } from '../lib/activityLog.js';
import { auditSource, submissionIds, SNAPSHOT, CLEARED } from '../lib/submissions.js';

// ═══════════════════════════════════════════════════════════════════════════
// Stock — the warehouse's batch-wise stock list. ADMIN ONLY.
//
//   Article  →  Batches  →  Quantity
//
// An article is an ordinary item (its name is still the identifier), with a
// description beside it. Each batch carries its own book quantity and,
// optionally, its own unit. The cafe never calls any of this.
// ═══════════════════════════════════════════════════════════════════════════

const router = Router();
router.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const clean = (v) => String(v ?? '').trim();

// Blank is "no figure", never zero. Anything else must be a non-negative number.
function parseQty(v) {
  const s = clean(v).replace(/,/g, '');
  if (s === '') return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { error: `Quantity "${clean(v)}" is not a non-negative number` };
  return { value: Number(n.toFixed(3)) };
}

// Accepts YYYY-MM-DD and DD-MM-YYYY / DD/MM/YYYY, the two forms a stock
// export realistically arrives in. Blank is no expiry.
function parseDate(v) {
  const s = clean(v);
  if (!s) return { value: null };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [, d, mo, y] = m;
  else return { error: `Expiry "${s}" is not a date (use YYYY-MM-DD)` };
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return { error: `Expiry "${s}" is not a real date` };
  return { value: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

// A batch only stores a unit when it differs from its article's — otherwise
// changing the article's unit would leave every batch showing the old one.
function batchUnit(rowUnit, articleUnit) {
  const u = clean(rowUnit);
  if (!u || u.toLowerCase() === clean(articleUnit).toLowerCase()) return null;
  return u;
}

const BATCH_COLUMNS = `b.id, b.item_id, b.batch_no, b.unit AS own_unit,
       COALESCE(NULLIF(btrim(b.unit), ''), i.unit) AS unit,
       b.qty, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date, b.is_active`;

// ── Stock list ──────────────────────────────────────────────────────────────
// One row per article with its batches attached, so the screen can show
// Article · Description · Batches · Quantity and expand to the batches.
router.get('/', async (req, res) => {
  const { search } = req.query;
  const active = ['inactive', 'all'].includes(req.query.active) ? req.query.active : 'active';
  const conds = [];
  const params = [];
  if (active === 'active') conds.push('i.is_active');
  else if (active === 'inactive') conds.push('NOT i.is_active');
  if (search) {
    params.push(`%${clean(search)}%`);
    // A batch number finds its article too: a counter reads it off the carton.
    conds.push(`(i.name ILIKE $1 OR i.description ILIKE $1
                 OR EXISTS (SELECT 1 FROM item_batches xb
                             WHERE xb.item_id = i.id AND xb.batch_no ILIKE $1))`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows: articles } = await query(
    `SELECT i.id, i.name, i.description, i.unit, i.is_liquor, i.is_active
       FROM items i ${where}
      ORDER BY lower(i.name)`,
    params
  );
  const ids = articles.map((a) => a.id);
  const { rows: batches } = ids.length ? await query(
    `SELECT ${BATCH_COLUMNS}
       FROM item_batches b JOIN items i ON i.id = b.item_id
      WHERE b.item_id = ANY($1::int[])
      ORDER BY b.is_active DESC, b.expiry_date NULLS LAST, lower(b.batch_no)`,
    [ids]
  ) : { rows: [] };

  const byItem = new Map();
  for (const b of batches) {
    if (!byItem.has(b.item_id)) byItem.set(b.item_id, []);
    byItem.get(b.item_id).push(b);
  }
  const out = articles.map((a) => {
    const list = byItem.get(a.id) || [];
    const live = list.filter((b) => b.is_active);
    return { ...a, batches: list, batch_count: live.length, quantities: totalsByUnit(live) };
  });

  const { rows: totals } = await query(
    `SELECT (SELECT count(*)::int FROM items WHERE is_active) AS articles,
            (SELECT count(*)::int FROM item_batches b JOIN items i ON i.id = b.item_id
              WHERE b.is_active AND i.is_active) AS batches,
            (SELECT count(*)::int FROM items WHERE NOT is_active) AS inactive`
  );
  res.json({ articles: out, counts: totals[0] });
});

// The Quantity column. Batches of one article can be held in different units
// (cartons in one batch, loose kg in another), and adding those together would
// produce a number in no unit at all — so the total is kept per unit.
function totalsByUnit(batches) {
  const map = new Map();
  for (const b of batches) {
    const key = clean(b.unit);
    const t = map.get(key) || { unit: key, qty: 0, missing: 0 };
    if (b.qty == null) t.missing += 1;
    else t.qty = Number((t.qty + Number(b.qty)).toFixed(3));
    map.set(key, t);
  }
  return [...map.values()];
}

// ── Batches ─────────────────────────────────────────────────────────────────
function readBatchBody(body, articleUnit) {
  const batchNo = normalizeName(body.batch_no);
  if (!batchNo) return { error: 'Batch number is required' };
  const q = parseQty(body.qty);
  if (q.error) return { error: q.error };
  const d = parseDate(body.expiry_date);
  if (d.error) return { error: d.error };
  return { batchNo, unit: batchUnit(body.unit, articleUnit), qty: q.value, expiry: d.value };
}

router.post('/:itemId/batches', requireIntParams('itemId'), async (req, res) => {
  const { rows: ir } = await query('SELECT id, name, unit FROM items WHERE id = $1', [req.params.itemId]);
  const item = ir[0];
  if (!item) return res.status(404).json({ error: 'Article not found' });
  const v = readBatchBody(req.body || {}, item.unit);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const { rows } = await query(
      `INSERT INTO item_batches (item_id, batch_no, unit, qty, expiry_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [item.id, v.batchNo, v.unit, v.qty, v.expiry]
    );
    await logActivity({
      entityType: 'item_batch', entityId: rows[0].id, action: 'create', recordCount: 1,
      detail: { article: item.name, batch_no: v.batchNo, qty: v.qty, unit: v.unit || item.unit },
      userId: req.user.id,
    });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `"${item.name}" already has a batch "${v.batchNo}"` });
    }
    throw err;
  }
});

router.put('/batches/:id', requireIntParams('id'), async (req, res) => {
  const { rows: br } = await query(
    `SELECT b.*, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry,
            i.name AS article, i.unit AS article_unit
       FROM item_batches b JOIN items i ON i.id = b.item_id WHERE b.id = $1`,
    [req.params.id]
  );
  const before = br[0];
  if (!before) return res.status(404).json({ error: 'Batch not found' });
  const body = { batch_no: before.batch_no, unit: before.unit ?? before.article_unit,
                 qty: before.qty, expiry_date: before.expiry, ...req.body };
  const v = readBatchBody(body, before.article_unit);
  if (v.error) return res.status(400).json({ error: v.error });
  const isActive = typeof req.body?.is_active === 'boolean' ? req.body.is_active : before.is_active;
  try {
    await query(
      `UPDATE item_batches
          SET batch_no = $2, unit = $3, qty = $4, expiry_date = $5, is_active = $6, updated_at = now()
        WHERE id = $1`,
      [before.id, v.batchNo, v.unit, v.qty, v.expiry, isActive]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `"${before.article}" already has a batch "${v.batchNo}"` });
    }
    throw err;
  }
  // Before and after, so a changed book quantity can always be traced.
  await logActivity({
    entityType: 'item_batch', entityId: before.id, action: 'update', recordCount: 1,
    detail: { article: before.article,
              before: { batch_no: before.batch_no, unit: before.unit, qty: before.qty, is_active: before.is_active },
              after: { batch_no: v.batchNo, unit: v.unit, qty: v.qty, is_active: isActive } },
    userId: req.user.id,
  });
  res.json({ ok: true });
});

// Removing a batch follows the same rule as items: a batch somebody has
// counted against is history, so it is DEACTIVATED and stays readable; a batch
// nobody has used is deleted outright.
router.delete('/batches/:id', requireIntParams('id'), async (req, res) => {
  const { rows: br } = await query(
    `SELECT b.*, i.name AS article,
            (SELECT count(*)::int FROM count_entries ce WHERE ce.batch_id = b.id)
          + (SELECT count(*)::int FROM submission_entries se WHERE se.batch_id = b.id) AS used
       FROM item_batches b JOIN items i ON i.id = b.item_id WHERE b.id = $1`,
    [req.params.id]
  );
  const batch = br[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  let outcome;
  if (batch.used > 0) {
    await query('UPDATE item_batches SET is_active = FALSE, updated_at = now() WHERE id = $1', [batch.id]);
    outcome = 'deactivated';
  } else {
    await query('DELETE FROM item_batches WHERE id = $1', [batch.id]);
    outcome = 'deleted';
  }
  await logActivity({
    entityType: 'item_batch', entityId: batch.id, action: outcome === 'deleted' ? 'delete' : 'deactivate',
    recordCount: 1, detail: { article: batch.article, batch_no: batch.batch_no, qty: batch.qty },
    userId: req.user.id,
  });
  res.json({
    outcome,
    message: outcome === 'deleted'
      ? `Batch "${batch.batch_no}" deleted.`
      : `Batch "${batch.batch_no}" has count entries, so it was deactivated rather than deleted.`,
  });
});

// ── CSV import ──────────────────────────────────────────────────────────────
// One row per batch:  article, description, batch, unit, quantity, expiry
//
//   upsert   create what is new, update what matches; nothing else changes
//   replace  as upsert, and every live batch NOT in the file is deactivated —
//            the file is the complete stock list
//
// A batch is matched on (article, batch number), both case-insensitively.
router.get('/import/template', (_req, res) => {
  const csv = toCsv(
    ['article', 'description', 'batch', 'unit', 'quantity', 'expiry'],
    [
      ['Refined Oil', 'Sunflower oil 15 L tin', 'B2401', 'TIN (15 LTR)', '40', '2026-12-31'],
      ['Refined Oil', 'Sunflower oil 15 L tin', 'B2407', 'TIN (15 LTR)', '12', '2027-03-31'],
      ['Basmati Rice', 'Premium long grain', 'R-118', 'KG', '250.5', ''],
      ['Paper Cups', '200 ml, sleeve of 50', 'PC-09', 'PKT (50 pcs)', '80', ''],
    ]
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock_template.csv"');
  res.send(csv);
});

const pick = (rec, names) => {
  for (const n of names) if (rec[n] !== undefined) return rec[n];
  return '';
};
const ARTICLE = ['article', 'article_name', 'item_name', 'item', 'name'];
const DESCRIPTION = ['description', 'article_description', 'desc'];
const BATCH = ['batch', 'batch_no', 'batch_number', 'batch no', 'batch number'];
const UNIT = ['unit', 'uom'];
const QTY = ['quantity', 'qty', 'stock', 'stock_qty', 'system_qty'];
const EXPIRY = ['expiry', 'expiry_date', 'exp', 'expiry date'];

router.post('/import', upload.single('file'), async (req, res) => {
  const mode = req.body?.mode === 'replace' ? 'replace' : 'upsert';
  const { filename, records } = readCsvUpload(req, { requireColumns: [ARTICLE, BATCH] });

  // Validate every row before writing anything, so a bad file changes nothing.
  const invalid = [];
  const valid = [];
  const seen = new Map();
  records.forEach((rec, idx) => {
    const line = idx + 2; // header is line 1
    const article = normalizeName(pick(rec, ARTICLE));
    const batchNo = normalizeName(pick(rec, BATCH));
    if (!article) { invalid.push({ row: line, reason: 'Article is blank' }); return; }
    if (!batchNo) { invalid.push({ row: line, article, reason: 'Batch is blank' }); return; }
    const q = parseQty(pick(rec, QTY));
    if (q.error) { invalid.push({ row: line, article, batch: batchNo, reason: q.error }); return; }
    const d = parseDate(pick(rec, EXPIRY));
    if (d.error) { invalid.push({ row: line, article, batch: batchNo, reason: d.error }); return; }
    const key = `${nameKey(article)}\u0000${nameKey(batchNo)}`;
    if (seen.has(key)) {
      invalid.push({ row: line, article, batch: batchNo,
                     reason: `Duplicate of row ${seen.get(key)} — the same article and batch twice` });
      return;
    }
    seen.set(key, line);
    valid.push({ line, article, batchNo, key,
                 description: clean(pick(rec, DESCRIPTION)), unit: clean(pick(rec, UNIT)),
                 qty: q.value, expiry: d.value });
  });

  if (invalid.length) {
    return res.status(400).json({
      error: `Nothing was imported — ${invalid.length} row(s) need fixing first.`,
      invalid, rows: records.length, filename,
    });
  }

  const summary = await withTransaction(async (c) => {
    const s = { rows: valid.length, articles_created: 0, articles_updated: 0,
                batches_created: 0, batches_updated: 0, batches_deactivated: 0 };
    const { rows: items } = await c.query('SELECT id, name, unit, description FROM items');
    const itemsByKey = new Map(items.map((i) => [nameKey(i.name), i]));
    const touchedBatchIds = [];
    const describedItems = new Set();

    for (const r of valid) {
      let item = itemsByKey.get(nameKey(r.article));
      if (!item) {
        const { rows } = await c.query(
          `INSERT INTO items (name, unit, description) VALUES ($1,$2,$3)
           RETURNING id, name, unit, description`,
          [r.article, r.unit, r.description || null]
        );
        item = rows[0];
        itemsByKey.set(nameKey(item.name), item);
        describedItems.add(item.id);
        s.articles_created += 1;
      } else if (r.description && r.description !== item.description && !describedItems.has(item.id)) {
        // An imported row may reactivate nothing and rename nothing: only the
        // description is taken from the file for an existing article.
        await c.query('UPDATE items SET description = $2 WHERE id = $1', [item.id, r.description]);
        item.description = r.description;
        describedItems.add(item.id);
        s.articles_updated += 1;
      }

      const { rows: existing } = await c.query(
        'SELECT id FROM item_batches WHERE item_id = $1 AND lower(btrim(batch_no)) = lower(btrim($2))',
        [item.id, r.batchNo]
      );
      const unit = batchUnit(r.unit, item.unit);
      if (existing[0]) {
        await c.query(
          `UPDATE item_batches SET unit = $2, qty = $3, expiry_date = COALESCE($4, expiry_date),
                  is_active = TRUE, updated_at = now()
            WHERE id = $1`,
          [existing[0].id, unit, r.qty, r.expiry]
        );
        touchedBatchIds.push(existing[0].id);
        s.batches_updated += 1;
      } else {
        const { rows } = await c.query(
          `INSERT INTO item_batches (item_id, batch_no, unit, qty, expiry_date)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [item.id, r.batchNo, unit, r.qty, r.expiry]
        );
        touchedBatchIds.push(rows[0].id);
        s.batches_created += 1;
      }
    }

    if (mode === 'replace') {
      // Deactivated, never deleted: a batch that was counted against must stay
      // readable in the count it belongs to.
      const { rowCount } = await c.query(
        `UPDATE item_batches SET is_active = FALSE, updated_at = now()
          WHERE is_active AND NOT (id = ANY($1::int[]))`,
        [touchedBatchIds]
      );
      s.batches_deactivated = rowCount;
    }

    await logActivity({
      entityType: 'stock_import', action: mode === 'replace' ? 'replace' : 'import',
      recordCount: valid.length, detail: { filename, mode, ...s }, userId: req.user.id,
    }, c);
    return s;
  });

  res.json({ ok: true, mode, filename, ...summary });
});

// ── Batch-wise count for one audit ──────────────────────────────────────────
// Book quantity beside counted quantity, batch by batch. Reads the same
// source as every other report: the submitted snapshot once there is one,
// the live count while counting is still in progress.
router.get('/count', async (req, res) => {
  const auditId = String(req.query.audit_id || '');
  if (!/^\d+$/.test(auditId)) return res.status(400).json({ error: 'audit_id required' });
  const src = await auditSource(auditId);
  if (!src.audit) return res.status(404).json({ error: 'Audit not found' });

  const fromSnapshot = src.mode === SNAPSHOT;
  const params = [auditId];
  if (fromSnapshot) params.push(submissionIds(src));
  const entries = src.mode === CLEARED
    ? `SELECT NULL::int AS item_id, NULL::int AS batch_id, NULL::numeric AS qty,
              NULL::int AS bottles, NULL::int AS open_ml WHERE $1::int IS NULL`
    : fromSnapshot
      // $1 is unused on this branch but still sent, so it is typed here.
      ? `SELECT item_id, batch_id, qty, bottles, open_ml FROM submission_entries
          WHERE submission_id = ANY($2::int[]) AND $1::int IS NOT NULL`
      : `SELECT item_id, batch_id, qty, bottles, open_ml FROM count_entries
          WHERE audit_id = $1 AND status = 'active'`;

  // Every live batch, counted or not, plus anything counted against an
  // article with no batch or a batch since retired — a count is never hidden
  // because the stock list changed underneath it.
  const { rows } = await query(
    `WITH e AS (${entries}),
     agg AS (
       SELECT item_id, batch_id, count(*)::int AS entries,
              sum(qty) AS qty, sum(bottles) AS bottles, sum(open_ml) AS open_ml
         FROM e GROUP BY item_id, batch_id
     ),
     keys AS (
       SELECT b.item_id, b.id AS batch_id FROM item_batches b
         JOIN items i ON i.id = b.item_id
        WHERE b.is_active AND i.is_active
       UNION
       SELECT item_id, batch_id FROM agg
     )
     SELECT i.id AS item_id, i.name AS article, i.description, i.is_liquor,
            k.batch_id, b.batch_no, b.is_active AS batch_active,
            COALESCE(NULLIF(btrim(b.unit), ''), i.unit) AS unit,
            b.qty AS stock_qty,
            COALESCE(a.entries, 0) AS entries,
            a.qty AS counted_qty, a.bottles AS counted_bottles, a.open_ml AS counted_open_ml
       FROM keys k
       JOIN items i ON i.id = k.item_id
       LEFT JOIN item_batches b ON b.id = k.batch_id
       LEFT JOIN agg a ON a.item_id = k.item_id AND a.batch_id IS NOT DISTINCT FROM k.batch_id
      ORDER BY lower(i.name), b.expiry_date NULLS LAST, lower(b.batch_no) NULLS FIRST`,
    params
  );

  const out = rows.map((r) => {
    const counted = r.entries > 0;
    // Liquor counts sealed bottles against the batch's book quantity; open ml
    // is shown on its own and never folded in.
    const physical = counted ? Number(r.is_liquor ? r.counted_bottles || 0 : r.counted_qty || 0) : null;
    const difference = counted && r.stock_qty != null
      ? Number((physical - Number(r.stock_qty)).toFixed(3)) : null;
    return { ...r, counted, physical_qty: physical, difference };
  });

  const source = src.mode === SNAPSHOT ? 'submitted' : src.mode === CLEARED ? 'cleared' : 'live';
  if (req.query.format === 'csv') {
    const csv = toCsv(
      ['Article', 'Description', 'Batch', 'Unit', 'System Qty', 'Physical Qty', 'Open ML', 'Difference', 'Status'],
      out.map((r) => [
        r.article, r.description || '', r.batch_no || '(no batch)', r.unit,
        r.stock_qty ?? '', r.physical_qty ?? '', r.is_liquor ? (r.counted_open_ml ?? '') : '',
        r.difference ?? '',
        !r.counted ? 'Not counted' : r.stock_qty == null ? 'No system qty'
          : r.difference === 0 ? 'Match' : r.difference > 0 ? 'Excess' : 'Short',
      ])
    );
    const name = `batch_count_${src.audit.store_code || src.audit.store_name}_${auditId}.csv`
      .replace(/[^A-Za-z0-9_.-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.send(csv);
  }
  res.json({ audit: src.audit, source, rows: out });
});

export default router;
