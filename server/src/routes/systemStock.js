import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects, readCsvUpload } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { toCsv } from '../lib/csvTemplate.js';
import { logActivity, activityFor } from '../lib/activityLog.js';
import { requireIntParams } from '../lib/asyncRoutes.js';

const router = Router();
// ADMIN ONLY — system (book) stock is never exposed to the auditor role.
router.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Guard thresholds (see /:auditId/preview).
const MIN_MATCH_RATE = 0.80;   // below this, warn: probably the wrong file
const MAX_COVERAGE_GAP = 0.20; // above this, warn: too many items have no figure

// The client's own export says `Item Name`; our template also accepts
// `item_name`. The first entry is the one quoted back when it is missing.
const REQUIRED_COLUMNS = [['Item Name', 'item_name', 'name']];

// ── Combined CSV template ───────────────────────────────────────────────────
router.get('/template', (_req, res) => {
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

// The active import for an audit (null when none), with who and when.
async function activeImport(auditId) {
  const { rows } = await query(
    `SELECT si.*, u.name AS imported_by_name
       FROM system_stock_imports si
       LEFT JOIN users u ON u.id = si.imported_by
      WHERE si.audit_id = $1 AND si.status = 'active'
      LIMIT 1`,
    [auditId]
  );
  return rows[0] || null;
}

async function systemStockStats(auditId) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM system_stock WHERE audit_id = $1) AS with_system,
            (SELECT count(*)::int FROM items WHERE is_active = TRUE) AS master_total`,
    [auditId]
  );
  return rows[0];
}

// ── Current system stock, listed against the full active master ─────────────
router.get('/:auditId', requireIntParams('auditId'), async (req, res) => {
  const { rows } = await query(
    `SELECT i.id AS item_id, i.name, i.unit, i.is_liquor, i.bottle_size_ml,
            COALESCE(sc.name,'—') AS super_category, COALESCE(c.name,'—') AS category,
            i.super_category_id, i.category_id,
            ss.qty, ss.bottles, ss.open_ml, ss.import_id, ss.updated_at,
            (ss.item_id IS NOT NULL) AS has_system
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
    [req.params.auditId]
  );
  const stats = await systemStockStats(req.params.auditId);
  res.json({ rows, source: await activeImport(req.params.auditId), ...stats });
});

// ── Import history (superseded imports are kept, marked 'replaced') ─────────
router.get('/:auditId/imports', requireIntParams('auditId'), async (req, res) => {
  const { rows } = await query(
    `SELECT si.*, u.name AS imported_by_name
       FROM system_stock_imports si
       LEFT JOIN users u ON u.id = si.imported_by
      WHERE si.audit_id = $1
      ORDER BY si.imported_at DESC`,
    [req.params.auditId]
  );
  res.json(rows);
});

router.get('/:auditId/activity', async (req, res) => {
  res.json(await activityFor(req.params.auditId, 'system_stock'));
});

// ── (1c) Edit one figure inline — the commonest correction ─────────────────
// No re-import required. The change is logged with old and new values.
router.put('/:auditId/item/:itemId', requireIntParams('auditId', 'itemId'), async (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const qty = num(b.qty), bottles = num(b.bottles), openMl = num(b.open_ml);
  if ([qty, bottles, openMl].some((v) => v != null && Number.isNaN(v))) {
    return res.status(400).json({ error: 'Quantities must be numbers' });
  }

  const { rows: before } = await query(
    'SELECT qty, bottles, open_ml FROM system_stock WHERE audit_id=$1 AND item_id=$2',
    [req.params.auditId, req.params.itemId]
  );

  const { rows } = await query(
    `INSERT INTO system_stock (audit_id, item_id, qty, bottles, open_ml, created_by, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,now())
     ON CONFLICT (audit_id, item_id) DO UPDATE
       SET qty=EXCLUDED.qty, bottles=EXCLUDED.bottles, open_ml=EXCLUDED.open_ml,
           updated_by=EXCLUDED.updated_by, updated_at=now(),
           -- A hand correction is no longer attributable to the import file.
           import_id = NULL
     RETURNING *`,
    [req.params.auditId, req.params.itemId, qty, bottles, openMl, req.user.id]
  );

  await logActivity({
    auditId: Number(req.params.auditId), entityType: 'system_stock',
    entityId: Number(req.params.itemId),
    action: before[0] ? 'update' : 'create',
    detail: { old: before[0] || null, new: { qty, bottles, open_ml: openMl } },
    userId: req.user.id,
  });

  res.json(rows[0]);
});

// ── (1b) Delete a single item's system stock row ───────────────────────────
// For fixing one wrong figure rather than the whole file. No typed confirmation.
router.delete('/:auditId/item/:itemId', requireIntParams('auditId', 'itemId'), async (req, res) => {
  const { rows } = await query(
    'DELETE FROM system_stock WHERE audit_id=$1 AND item_id=$2 RETURNING qty, bottles, open_ml',
    [req.params.auditId, req.params.itemId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No system stock for that item' });

  await logActivity({
    auditId: Number(req.params.auditId), entityType: 'system_stock',
    entityId: Number(req.params.itemId), action: 'delete',
    detail: { removed: rows[0] }, userId: req.user.id,
  });
  res.json({ ok: true, removed: rows[0] });
});

// ── (1a) Clear ALL system stock for this audit ─────────────────────────────
// Typed confirmation required. Physical count entries are NOT touched.
const CLEAR_PHRASE = 'CLEAR SYSTEM STOCK';

router.post('/:auditId/clear', requireIntParams('auditId'), async (req, res) => {
  if ((req.body?.confirm || '').trim().toUpperCase() !== CLEAR_PHRASE) {
    return res.status(400).json({ error: `Type "${CLEAR_PHRASE}" to confirm` });
  }
  const auditId = Number(req.params.auditId);
  const src = await activeImport(auditId);

  const removed = await withTransaction(async (c) => {
    const { rowCount } = await c.query('DELETE FROM system_stock WHERE audit_id = $1', [auditId]);
    await c.query(
      `UPDATE system_stock_imports SET status='cleared' WHERE audit_id=$1 AND status='active'`,
      [auditId]
    );
    await logActivity({
      auditId, entityType: 'system_stock', entityId: src?.id ?? null, action: 'clear',
      detail: { removed_rows: rowCount, source_filename: src?.filename ?? null },
      userId: req.user.id,
    }, c);
    return rowCount;
  });

  res.json({ ok: true, removed });
});

// ── CSV analysis shared by preview and commit ───────────────────────────────
// Accepts our template and the client's own export. LOC is not used for
// matching — MATCHING IS ON ITEM NAME — but it is inspected as a wrong-file guard.
const pickName = (r) => r.item_name ?? r['item name'] ?? r.name;
const pickQty = (r) => r.system_qty ?? r['closing qty'] ?? r.closing_qty;
const pickSuper = (r) => r.super_category ?? r['super category name'] ?? r.super_category_name ?? '';
const pickCategory = (r) => r.category ?? r['category name'] ?? r.category_name ?? '';
const pickLoc = (r) => r.loc ?? r.location ?? r.store ?? '';

async function analyse(records) {
  const { rows: items } = await query(
    'SELECT id, name, is_liquor FROM items WHERE is_active = TRUE');
  // Both sides trimmed and internal double spaces collapsed before comparing.
  const byName = new Map(items.map((i) => [nameKey(i.name), i]));

  const matched = [];
  const unmatched = [];
  const invalid = [];
  const seen = new Set();
  const locs = new Set();

  records.forEach((r, idx) => {
    const row = idx + 2;
    const loc = normalizeName(pickLoc(r));
    if (loc) locs.add(loc.toUpperCase());

    const name = normalizeName(pickName(r));
    if (!name) { invalid.push({ row, name: '', error: 'Item Name is required' }); return; }
    const key = nameKey(name);
    if (seen.has(key)) { invalid.push({ row, name, error: 'duplicate name within file' }); return; }
    seen.add(key);

    const item = byName.get(key);
    if (!item) {
      unmatched.push({
        row, name,
        super_category: normalizeName(pickSuper(r)),
        category: normalizeName(pickCategory(r)),
        loc,
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
      matched.push({
        row, name, item_id: item.id, is_liquor: true,
        qty: null, bottles: bottles ?? closing ?? 0, open_ml: openMl ?? 0,
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

  // Master items with no row in the file — a coverage gap, never hidden.
  const matchedIds = new Set(matched.map((m) => m.item_id));
  const { rows: missingRows } = await query(
    `SELECT i.id AS item_id, i.name, COALESCE(sc.name,'—') AS super_category,
            COALESCE(c.name,'—') AS category
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`
  );
  const missing = missingRows.filter((m) => !matchedIds.has(m.item_id));

  return { matched, unmatched, invalid, missing, locs: [...locs] };
}

// ── (2)+(3) Preview: disclose the replacement and challenge suspicious files ─
router.post('/:auditId/preview', requireIntParams('auditId'), upload.single('file'), async (req, res) => {
  // Throws CsvFormatError naming the actual reason when the file is unusable.
  const { filename, records } = readCsvUpload(req, { requireColumns: REQUIRED_COLUMNS });

  const auditId = Number(req.params.auditId);
  const { rows: auditRows } = await query(
    `SELECT a.id, a.audit_date, a.cutoff_time, s.code AS store_code, s.name AS store_name
       FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id = $1`,
    [auditId]
  );
  const audit = auditRows[0];
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  const { matched, unmatched, invalid, missing, locs } = await analyse(records);
  const stats = await systemStockStats(auditId);
  const existing = await activeImport(auditId);

  const total = records.length;
  const matchRate = total > 0 ? matched.length / total : 0;
  const coverageGap = stats.master_total > 0 ? missing.length / stats.master_total : 0;

  // ── Wrong-file guards ────────────────────────────────────────────────────
  const warnings = [];
  let blocked = null;

  // (a) STORE MISMATCH — every row carries the same LOC and it isn't this store.
  if (locs.length === 1 && audit.store_code &&
      locs[0].toUpperCase() !== String(audit.store_code).toUpperCase()) {
    blocked = {
      code: 'store_mismatch',
      message: `This file is for LOC '${locs[0]}'. This audit is for store '${audit.store_code}'. Import blocked.`,
      file_loc: locs[0], audit_store: audit.store_code,
    };
  }

  // (b) LOW MATCH RATE
  if (total > 0 && matchRate < MIN_MATCH_RATE) {
    warnings.push({
      code: 'low_match_rate',
      message: `Only ${Math.round(matchRate * 100)}% of rows matched. This may be the wrong file or the wrong master. Review before continuing.`,
    });
  }

  // (c) LARGE COVERAGE GAP
  if (coverageGap > MAX_COVERAGE_GAP) {
    warnings.push({
      code: 'coverage_gap',
      message: `${missing.length} of ${stats.master_total} items have no system figure. Those items will show as NO SYSTEM DATA.`,
    });
  }

  // (d) DUPLICATE IMPORT — same filename already imported for this audit.
  const { rows: dup } = await query(
    `SELECT si.imported_at, u.name AS imported_by_name
       FROM system_stock_imports si LEFT JOIN users u ON u.id = si.imported_by
      WHERE si.audit_id = $1 AND lower(si.filename) = lower($2)
      ORDER BY si.imported_at DESC LIMIT 1`,
    [auditId, filename]
  );
  if (dup[0]) {
    warnings.push({
      code: 'duplicate_import',
      message: `A file named '${filename}' was already imported for this audit on ${new Date(dup[0].imported_at).toLocaleString()}${dup[0].imported_by_name ? ' by ' + dup[0].imported_by_name : ''}. Import again?`,
    });
  }

  res.json({
    audit: {
      id: audit.id, store_code: audit.store_code, store_name: audit.store_name,
      audit_date: audit.audit_date, cutoff_time: audit.cutoff_time,
    },
    filename,
    total,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    invalidCount: invalid.length,
    missingCount: missing.length,
    masterTotal: stats.master_total,
    matchRate: Number((matchRate * 100).toFixed(1)),
    // What committing will replace.
    existing: existing
      ? { ...existing, rows: stats.with_system }
      : (stats.with_system > 0 ? { filename: null, rows: stats.with_system } : null),
    willReplace: stats.with_system > 0,
    blocked,
    warnings,
    // Both lists are always returned in full — neither is ever hidden.
    matched, unmatched, invalid, missing,
    fileLocs: locs,
  });
});

// Downloadable unmatched / missing lists (never hidden from the admin).
router.post('/:auditId/preview/download', upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const which = req.query.list === 'missing' ? 'missing' : 'unmatched';
  const { records } = parseCsvObjects(text);
  const { unmatched, missing } = await analyse(records);

  const csv = which === 'missing'
    ? toCsv(['Super Category', 'Category', 'Item Name'],
        missing.map((m) => [m.super_category, m.category, m.name]))
    : toCsv(['Row', 'Item Name', 'Super Category', 'Category', 'LOC'],
        unmatched.map((u) => [u.row, u.name, u.super_category, u.category, u.loc || '']));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="system_stock_${which}.csv"`);
  res.send(csv);
});

// ── Commit: clear then insert inside ONE transaction ───────────────────────
// A failed import can never leave the audit with half the old data and half the
// new. A blocking guard requires an explicit typed override plus a reason.
router.post('/:auditId/commit', requireIntParams('auditId'), upload.single('file'), async (req, res) => {
  // The same checks as the preview: the commit must never accept a file the
  // preview would have rejected.
  const { filename, records } = readCsvUpload(req, { requireColumns: REQUIRED_COLUMNS });
  const auditId = Number(req.params.auditId);

  const { rows: auditRows } = await query(
    `SELECT a.id, s.code AS store_code FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id=$1`,
    [auditId]
  );
  if (!auditRows[0]) return res.status(404).json({ error: 'Audit not found' });
  const storeCode = auditRows[0].store_code;

  const { matched, unmatched, invalid, locs } = await analyse(records);
  if (invalid.length) {
    const shown = invalid.slice(0, 3).map((v) => `row ${v.row} (${v.name || 'no name'}): ${v.error}`);
    return res.status(400).json({
      error: `Import failed — ${invalid.length} row(s) have errors. ${shown.join(' · ')}` +
             (invalid.length > shown.length ? ` · and ${invalid.length - shown.length} more.` : ''),
      code: 'invalid_rows', invalid,
    });
  }

  // Re-check the blocking guard server-side; the UI cannot wave it through.
  const mismatch = locs.length === 1 && storeCode &&
    locs[0].toUpperCase() !== String(storeCode).toUpperCase();
  const overrideReason = (req.body?.override_reason || '').trim();
  if (mismatch) {
    const confirmed = (req.body?.override_confirm || '').trim().toUpperCase() === 'IMPORT ANYWAY';
    if (!confirmed || !overrideReason) {
      return res.status(409).json({
        error: `This file is for LOC '${locs[0]}'. This audit is for store '${storeCode}'. Import blocked.`,
        code: 'store_mismatch',
        requiresOverride: true,
        file_loc: locs[0], audit_store: storeCode,
      });
    }
  }

  const result = await withTransaction(async (c) => {
    // Supersede the previous import — kept, not deleted, so the re-import is visible.
    const { rows: prev } = await c.query(
      `UPDATE system_stock_imports SET status='replaced'
        WHERE audit_id=$1 AND status='active' RETURNING id, filename`,
      [auditId]
    );
    const { rowCount: removed } = await c.query(
      'DELETE FROM system_stock WHERE audit_id = $1', [auditId]);

    const { rows: imp } = await c.query(
      `INSERT INTO system_stock_imports
         (audit_id, filename, row_count, matched_count, unmatched_count, imported_by, status, override_reason)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,
      [auditId, filename, records.length, matched.length, unmatched.length, req.user.id,
       mismatch ? overrideReason : null]
    );
    const importId = imp[0].id;

    for (const m of matched) {
      await c.query(
        `INSERT INTO system_stock (audit_id, item_id, qty, bottles, open_ml, created_by, import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [auditId, m.item_id, m.qty, m.bottles, m.open_ml, req.user.id, importId]
      );
    }

    await logActivity({
      auditId, entityType: 'system_stock', entityId: importId,
      action: prev[0] ? 'replace' : 'import',
      detail: {
        filename, rows: records.length, matched: matched.length,
        unmatched: unmatched.length, removed_rows: removed,
        replaced_filename: prev[0]?.filename ?? null,
        store_mismatch_override: mismatch ? { file_loc: locs[0], reason: overrideReason } : null,
      },
      userId: req.user.id,
    }, c);

    return { importId, replacedPrevious: !!prev[0], removed };
  });

  res.json({
    ok: true, imported: matched.length, unmatched: unmatched.length,
    // The screen states the outcome against what was in the file, so
    // "594 of 618 rows imported, 24 not matched" is visible rather than implied.
    rowsInFile: records.length, filename, ...result,
  });
});

export default router;
