import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { readCsvUpload } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { toCsv } from '../lib/csvTemplate.js';
import { logActivity } from '../lib/activityLog.js';
import { buildWorkbook } from '../lib/exporters.js';
import { batchReport, batchSheets, SUMMARY_HEADERS, summaryRow } from '../lib/batchReport.js';

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
       b.qty, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date, b.is_active,
       b.origin, b.created_at, b.created_in_audit,
       (SELECT name FROM users WHERE id = b.created_by) AS created_by_name,
       (SELECT s.name || ' · ' || to_char(a.audit_date, 'YYYY-MM-DD')
          FROM audits a JOIN stores s ON s.id = a.store_id
         WHERE a.id = b.created_in_audit) AS created_in_audit_label`;

// ── Stock list ──────────────────────────────────────────────────────────────
// One row per article with its batches attached, so the screen can show
// Article · Description · Batches · Quantity and expand to the batches.
router.get('/', async (req, res) => {
  const { search } = req.query;
  const active = ['inactive', 'all'].includes(req.query.active) ? req.query.active : 'active';
  // Stock is the warehouse side. Cafe items live on the Item Master.
  const conds = ["i.inventory_mode = 'warehouse'"];
  const params = [];
  if (active === 'active') conds.push('i.is_active');
  else if (active === 'inactive') conds.push('NOT i.is_active');
  // Only articles that have a batch created by a counter.
  if (req.query.origin === 'counted') {
    conds.push(`EXISTS (SELECT 1 FROM item_batches nb WHERE nb.item_id = i.id AND nb.origin = 'counted')`);
  }
  if (req.query.super_category_id === 'none') conds.push('i.super_category_id IS NULL');
  else if (/^\d+$/.test(String(req.query.super_category_id || ''))) {
    params.push(Number(req.query.super_category_id));
    conds.push(`i.super_category_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${clean(search)}%`);
    // A batch number finds its article too: a counter reads it off the carton.
    const n = `$${params.length}`;
    conds.push(`(i.name ILIKE ${n} OR i.description ILIKE ${n}
                 OR EXISTS (SELECT 1 FROM item_batches xb
                             WHERE xb.item_id = i.id AND xb.batch_no ILIKE ${n}))`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows: articles } = await query(
    `SELECT i.id, i.name, i.description, i.unit, i.is_liquor, i.is_active,
            i.super_category_id, i.category_id,
            sc.name AS super_category_name, c.name AS category_name
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       ${where}
      ORDER BY sc.sort_order NULLS LAST, sc.name NULLS LAST, c.name NULLS LAST, lower(i.name)`,
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
    `SELECT (SELECT count(*)::int FROM items WHERE is_active AND inventory_mode = 'warehouse') AS articles,
            (SELECT count(*)::int FROM item_batches b JOIN items i ON i.id = b.item_id
              WHERE b.is_active AND i.is_active AND i.inventory_mode = 'warehouse') AS batches,
            (SELECT count(*)::int FROM items WHERE NOT is_active AND inventory_mode = 'warehouse') AS inactive,
            (SELECT count(*)::int FROM item_batches WHERE origin = 'counted') AS new_batches`
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
    ['super_category', 'category', 'article', 'description', 'batch', 'unit', 'quantity', 'expiry'],
    [
      ['FOOD', 'PROVISION', 'Refined Oil', 'Sunflower oil 15 L tin', 'B2401', 'TIN (15 LTR)', '40', '2026-12-31'],
      ['FOOD', 'PROVISION', 'Refined Oil', 'Sunflower oil 15 L tin', 'B2407', 'TIN (15 LTR)', '12', '2027-03-31'],
      ['FOOD', 'PROVISION', 'Basmati Rice', 'Premium long grain', 'R-118', 'KG', '250.5', ''],
      ['NON FOOD', 'PACKAGING', 'Paper Cups', '200 ml, sleeve of 50', 'PC-09', 'PKT (50 pcs)', '80', ''],
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
const SUPER = ['super_category', 'super category', 'super_category_name', 'super category name'];
const CATEGORY = ['category', 'category_name', 'category name'];
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
    const superName = normalizeName(pick(rec, SUPER));
    const catName = normalizeName(pick(rec, CATEGORY));
    if (catName && !superName) {
      invalid.push({ row: line, article, batch: batchNo, reason: 'Category needs a super category' });
      return;
    }
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
    valid.push({ line, article, batchNo, key, superName, catName,
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
    const { rows: items } = await c.query(
      `SELECT id, name, unit, description, super_category_id, category_id
         FROM items WHERE inventory_mode = 'warehouse'`);
    const itemsByKey = new Map(items.map((i) => [nameKey(i.name), i]));
    const touchedBatchIds = [];
    const describedItems = new Set();
    s.categories_created = 0;

    // A super category / category named in the file but not yet in the
    // system is CREATED — the same rule as the Item Master import. The lists
    // are shared with the cafe; a card only shows where it has items.
    const hier = new Map();
    async function resolveHierarchy(superName, catName) {
      if (!superName) return { superId: null, catId: null };
      const k = `${nameKey(superName)}\u0000${nameKey(catName)}`;
      if (hier.has(k)) return hier.get(k);
      const { rows: sr } = await c.query(
        `INSERT INTO super_categories (name, sort_order) VALUES ($1, 99)
         ON CONFLICT (lower(name)) DO UPDATE SET name = super_categories.name
         RETURNING id, (xmax = 0) AS created`, [superName]);
      if (sr[0].created) s.categories_created += 1;
      let catId = null;
      if (catName) {
        const { rows: cr } = await c.query(
          `INSERT INTO categories (name, super_category_id) VALUES ($1, $2)
           ON CONFLICT (super_category_id, lower(name)) DO UPDATE SET name = categories.name
           RETURNING id, (xmax = 0) AS created`, [catName, sr[0].id]);
        if (cr[0].created) s.categories_created += 1;
        catId = cr[0].id;
      }
      const out = { superId: sr[0].id, catId };
      hier.set(k, out);
      return out;
    }

    for (const r of valid) {
      let item = itemsByKey.get(nameKey(r.article));
      const { superId, catId } = await resolveHierarchy(r.superName, r.catName);
      if (!item) {
        const { rows } = await c.query(
          `INSERT INTO items (name, unit, description, super_category_id, category_id, inventory_mode)
           VALUES ($1,$2,$3,$4,$5,'warehouse')
           RETURNING id, name, unit, description, super_category_id, category_id`,
          [r.article, r.unit, r.description || null, superId, catId]
        );
        item = rows[0];
        itemsByKey.set(nameKey(item.name), item);
        describedItems.add(item.id);
        s.articles_created += 1;
      } else if (!describedItems.has(item.id)
                 && ((r.description && r.description !== item.description)
                     || (superId && (superId !== item.super_category_id || catId !== item.category_id)))) {
        // For an existing article only the description and the category are
        // taken from the file — nothing is renamed or reactivated. A blank
        // cell leaves the current value alone. The first row of an article
        // decides; its other batch rows do not change it again.
        await c.query(
          `UPDATE items SET description = COALESCE($2, description),
                  super_category_id = COALESCE($3, super_category_id),
                  category_id = CASE WHEN $3::int IS NULL THEN category_id ELSE $4 END
            WHERE id = $1`,
          [item.id, r.description || null, superId, catId]);
        if (r.description) item.description = r.description;
        if (superId) { item.super_category_id = superId; item.category_id = catId; }
        describedItems.add(item.id);
        s.articles_updated += 1;
      } else {
        describedItems.add(item.id);
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
      // Batches a counter created are NOT the stock list's to retire: they
      // exist because somebody found them on the shelf, and must stay
      // available until the admin removes them deliberately.
      const { rowCount } = await c.query(
        `UPDATE item_batches SET is_active = FALSE, updated_at = now()
          WHERE is_active AND origin = 'stock' AND NOT (id = ANY($1::int[]))`,
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
// Book quantity beside counted quantity, batch by batch, including every batch
// a counter created during the audit. JSON for the screen, or the same rows as
// CSV or an Excel workbook (summary sheet + one line per entry).
router.get('/count', async (req, res) => {
  const auditId = String(req.query.audit_id || '');
  if (!/^\d+$/.test(auditId)) return res.status(400).json({ error: 'audit_id required' });
  const report = await batchReport(auditId);
  if (!report) return res.status(404).json({ error: 'Audit not found' });

  const base = `batch_count_${report.audit.store_code || report.audit.store_name}_${auditId}`
    .replace(/[^A-Za-z0-9_.-]+/g, '_');
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(toCsv(SUMMARY_HEADERS, report.rows.map(summaryRow)));
  }
  if (req.query.format === 'xlsx') {
    const buf = await buildWorkbook(batchSheets(report));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(buf);
  }
  res.json(report);
});

export default router;
