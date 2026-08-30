import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAudit, physicalSummary, itemDetailTotals, liquorReport,
  varianceReport, consolidated, exceptionReport,
} from '../lib/reports.js';
import { buildWorkbook, buildPdf } from '../lib/exporters.js';
import { buildAuditWorkbook } from '../lib/auditWorkbook.js';
import { auditSource, clearedNotice, CLEARED } from '../lib/submissions.js';
import { reportFields, reportColumns, fieldValue, bucketValue } from '../lib/columns.js';

const router = Router();
// Reports are ADMIN ONLY (auditors have no reports, no rates).
router.use(requireAuth, requireRole('admin'));

// ── Cleared submissions stop here ───────────────────────────────────────────
// One guard for every report, because every report route carries :auditId.
// If the admin cleared the submitted data there is nothing to report on, and
// rendering the table anyway would print each item as a 100% shortage — a
// finding that never happened. Say what was cleared instead.
//
// 409 rather than 200, so an Excel or PDF download surfaces the message
// instead of saving a file full of zeroes.
router.param('auditId', async (req, res, next, auditId) => {
  const src = await auditSource(auditId);
  if (src.mode !== CLEARED) { req.auditSource = src; return next(); }
  const notice = clearedNotice(src.cleared);
  res.status(409).json({ error: notice.message, cleared: notice });
});

const LIQUOR_FOOTNOTE = 'Open bottle quantities are recorded by visual estimation.';
const n = (v) => (v == null ? '' : v);

// ── The one row builder every report uses ───────────────────────────────────
// R1, R2, R3 and R4 all print the SAME columns for the same item, so they all
// go through here. This is what stopped them drifting apart: there is nowhere
// left for a report to decide for itself what a row looks like.
//
// A money column is BLANK when the item has no rate — never 0. On an audit
// report "priced at zero" and "nobody has priced this yet" must not look the
// same.
const rowFor = (fields) => (r) => fields.map((f) => {
  const v = fieldValue(r, f);
  if (f.money) return v == null ? '' : v;
  if (f.key === 'remarks' && r.not_counted) return `${r.remarks} · NOT COUNTED`;
  return v == null ? '' : v;
});

// A subtotal carries the same figures in the same columns, so a column reads
// straight down from an item line to the grand total. Anything that cannot be
// summed is left blank rather than repeated misleadingly.
const subtotalFor = (fields) => (label, b, labelKey = 'category') => fields.map((f) => {
  if (f.key === labelKey) return label;
  if (f.key === 'remarks') return `${b.items} items`;
  const v = bucketValue(b, f);
  return v == null ? '' : v;
});

// Reports given to the client show TOTALS ONLY — one line per item. The
// per-entry breakdown lives on the admin count screen, never in a report.

async function sendXlsx(res, filename, sheets) {
  const buf = await buildWorkbook(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
}
async function sendPdf(res, filename, doc) {
  const buf = await buildPdf(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  res.send(buf);
}
const slug = (s) => String(s || 'store').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Column widths for the standard set on A4 landscape. The location columns
// share what is left over, so adding a location narrows them rather than
// pushing the quantity columns off the page.
function pdfWidths(locations = [], { withSystem = false } = {}) {
  const locW = Math.max(24, Math.min(46, Math.round(
    (withSystem ? 150 : 230) / Math.max(1, locations.length))));
  return [
    22, 30, withSystem ? 58 : 70, withSystem ? 58 : 70, withSystem ? 88 : 128,
    withSystem ? 44 : 56, 34,
    ...locations.map(() => locW),
    40, 40, 50, withSystem ? 40 : 52,
    ...(withSystem ? [36, 34, 44, 44, 36, 44, 40] : []),
  ];
}

// A DATE column comes back from pg as a Date. Reports want the plain calendar
// day, not "Wed Aug 05 2026 00:00:00 GMT+0000".
const ymd = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

// ── R1 Physical Stock Summary ────────────────────────────────────────────────
// The standard columns, grouped Super Category › Category, with a Value column
// and the subtotals kept.
router.get('/physical-summary/:auditId', async (req, res) => {
  const data = await physicalSummary(req.params.auditId);
  const { audit, locations, groups, grand } = data;
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const format = req.query.format;
  const fname = `R1_physical_summary_${slug(audit.store_name)}`;

  // R1 summarises by category, so it drops the per-item identity columns and
  // adds Value. The location columns and the three quantity columns are the
  // same ones, in the same order, as every other report.
  const cols = ['Super Category', 'Category', 'Items',
                ...locations.map((l) => l.name),
                'Total (native unit)', 'ML / Loose Qty (Open Bottle, ml)',
                'Final Total Qty (ML / GM / KG / Count)', 'Value'];
  const line = (label, cat, b) => [label, cat, b.items,
    ...locations.map((_, i2) => b.by_location?.[i2] ?? 0),
    b.location_total, b.loose_ml, b.final_total_qty, b.value];

  const rowsOut = [];
  for (const g of groups) {
    for (const c of g.categories) rowsOut.push(line(g.super_category, c.category, c));
    rowsOut.push(line(`${g.super_category} — SUBTOTAL`, '', g));
    rowsOut.push([]);
  }
  rowsOut.push(line('GRAND TOTAL', '', grand));

  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{ name: 'Physical Summary', aoa: [cols, ...rowsOut] }]);
  }
  if (format === 'pdf') {
    const w = [72, 72, 30, ...locations.map(() => 40), 52, 46, 58, 60];
    return sendPdf(res, fname, {
      title: 'R1 — Physical Stock Summary',
      subtitle: `${audit.store_name} — ${ymd(audit.audit_date)}`,
      blocks: [{ title: 'By super category and category', columns: cols, widths: w,
                 rows: rowsOut.filter((r) => r.length) }],
    });
  }
  res.json({ audit, locations, groups, grand, categories: data.categories, columns: cols });
});

// ── R2 Item Detail — TOTALS ONLY, on the standard columns ────────────────────
router.get('/item-detail/:auditId', async (req, res) => {
  const { audit, locations, rows } = await itemDetailTotals(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const format = req.query.format;
  const fname = `R2_item_detail_${slug(audit.store_name)}`;
  const fields = reportFields(locations);
  const cols = fields.map((f) => f.label);
  const toRow = rowFor(fields);

  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{ name: 'Item Detail', aoa: [cols, ...rows.map(toRow)] }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R2 — Item Detail', subtitle: `${audit.store_name} — ${ymd(audit.audit_date)}`,
      blocks: [{ title: 'Totals by item', columns: cols, widths: pdfWidths(locations),
                 rows: rows.map(toRow), note: LIQUOR_FOOTNOTE }],
    });
  }
  res.json({ audit, locations, rows, columns: cols });
});

// ── R3 Liquor Report — the standard columns, liquor only ────────────────────
// Sealed bottles and open ml stay SEPARATE and are never combined: the
// location columns carry sealed bottles, open ml has its own column.
router.get('/liquor/:auditId', async (req, res) => {
  const { audit, locations, rows, footnote } = await liquorReport(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const format = req.query.format;
  const fname = `R3_liquor_${slug(audit.store_name)}`;
  const fields = reportFields(locations);
  const cols = fields.map((f) => f.label);
  const toRow = rowFor(fields);

  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{
      name: 'Liquor', aoa: [cols, ...rows.map(toRow), [], ['Note:', footnote]],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R3 — Liquor Report', subtitle: `${audit.store_name} — ${ymd(audit.audit_date)}`,
      blocks: [{ title: 'Liquor', columns: cols, widths: pdfWidths(locations),
                 rows: rows.map(toRow), note: footnote }],
    });
  }
  res.json({ audit, locations, rows, columns: cols, footnote });
});

// ── R4 Variance Report ───────────────────────────────────────────────────────
// An export from an OPEN audit is stamped PROVISIONAL in the file header.
router.get('/variance/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const countedOnly = req.query.filter === 'counted';
  const categoryId = req.query.category_id || null;
  const superCategoryId = req.query.super_category_id || null;
  const grouped = req.query.group_by === 'category' || req.query.group_by === 'hierarchy';
  // [All] [With system data] [No system data]
  const systemData = ['with', 'without'].includes(req.query.system_data)
    ? req.query.system_data : 'all';
  // [All] [With rate] [No rate] — isolates the items the value columns cannot
  // speak for.
  const rateFilter = ['with', 'without'].includes(req.query.rate)
    ? req.query.rate : 'all';
  // [All] [Counted] [Not counted with system stock]. `filter=counted` is the
  // older spelling and still works.
  const countFilter = ['counted', 'not_counted'].includes(req.query.count)
    ? req.query.count : null;
  // The standard report carries items with physical stock only. `include_nil=1`
  // puts the nil-stock rows back on the table.
  const includeNilStock = req.query.include_nil === '1' || req.query.include_nil === 'true';
  const { rows, groups, grand, summary, provisional, progress, totals, hasSystemStock,
          provenance, notStocked, nilStock, locations } =
    await varianceReport(req.params.auditId,
      { countedOnly, countFilter, categoryId, superCategoryId, systemData, rateFilter,
        includeNilStock });
  const format = req.query.format;

  // A physical-only audit is a complete deliverable. The report renders on the
  // BASE columns alone; the five system columns appear only when there are
  // system figures to compare against. Nothing is blocked and nothing demands
  // an upload.
  const withSystem = hasSystemStock;

  const fname = `${provisional ? 'PROVISIONAL_' : ''}R4_${withSystem ? 'variance' : 'physical_audit'}_${slug(audit.store_name)}`;
  const stamp = provisional
    ? `PROVISIONAL — count in progress. ${progress.uncounted} of ${progress.total} items not yet counted.`
    : null;

  const src = provenance.source;
  const headerLines = [
    `Location: ${audit.store_code || audit.store_name}`,
    `Audit date: ${ymd(audit.audit_date)}`,
    `Total items: ${rows.length}`,
    // Provenance — stated whenever there are system figures to attribute.
    ...(withSystem ? [
      `System stock source: ${src?.filename || 'entered manually'}`,
      src ? `Imported: ${new Date(src.imported_at).toLocaleString()}${src.imported_by_name ? ' by ' + src.imported_by_name : ''}` : null,
      `Coverage: ${provenance.with_system} of ${provenance.master_total} master items`,
      totals.no_system_data > 0
        ? `${totals.no_system_data} item(s) shown as NO SYSTEM DATA and excluded from variance totals` : null,
      totals.no_rate > 0
        ? `${totals.no_rate} item(s) have no rate — value figures exclude them` : null,
      // Value is Final Total Qty × Rate, and Final Total Qty is in the BASE
      // measure. For a packed item the rate must therefore be per ml / per gm.
      totals.rate_per_base_unit > 0
        ? `${totals.rate_per_base_unit} priced item(s) have a pack size above 1 — their value columns are Final Total Qty × Rate, so the rate must be per ML/GM, not per pack`
        : null,
      totals.not_counted > 0
        ? `${totals.not_counted} item(s) marked NOT COUNTED — system stock exists but no count was recorded; shown as a full shortage` : null,
    ] : ['Physical count only — no system stock imported for this audit.']),
    totals.not_stocked > 0
      ? `${totals.not_stocked} master item(s) neither counted nor present in system stock — not stocked at this outlet, excluded from this report`
      : null,
    nilStock.count > 0
      ? `${nilStock.count} item(s) counted at nil with no system figure — excluded on the "physical stock only" basis`
      : null,
  ].filter(Boolean);

  // ── Standard audit report column set ─────────────────────────────────────
  // Base columns are always present. The five system columns are appended only
  // when system figures exist, and nothing else about the layout changes.
  // One column per LOCATION, read from the locations table in sort order —
  // never hardcoded, so renaming a place or adding a sixth changes the report
  // with no code change. The same columns appear for every store.
  // The SAME definition R1, R2 and R3 use. With system stock the seven system
  // columns are appended and nothing about the base columns changes — Unit,
  // Bottle/Unit Size and the location columns all stay exactly where they are.
  const fields = reportFields(locations, { withSystem });
  const cols = fields.map((f) => f.label);

  if (format === 'xlsx') {
    return sendXlsx(res, fname, buildAuditWorkbook({
      audit, rows, groups, grand, summary, totals, withSystem, grouped, stamp,
      headerLines, cols, nilStock, locations,
    }));
  }

  if (format === 'pdf') {
    // 13 (or 18) columns will not fit A4 portrait legibly, so the PDF carries
    // the identifying columns plus the quantity columns; the Excel export is
    // the full-fidelity deliverable.
    const widths = pdfWidths(locations, { withSystem });
    const pdfRow = rowFor(fields);
    const pdfSubtotal = (label, b, key) => subtotalFor(fields)(label, b, key);
    const pdfCols = cols;
    const pdfWidthsArr = widths;
    return sendPdf(res, fname, {
      title: `R4 — ${withSystem ? 'Variance Report' : 'Physical Audit Report'}${provisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: `${audit.store_name} — ${ymd(audit.audit_date)}\n${headerLines.join('\n')}`,
      banner: stamp,
      blocks: [
        ...(grouped
          ? [...groups.flatMap((g) => [
              ...g.categories.map((c) => ({
                title: `${g.super_category} › ${c.category}`,
                columns: pdfCols, widths: pdfWidthsArr,
                rows: [...c.rows.map(pdfRow), pdfSubtotal('SUBTOTAL', c, 'category')],
              })),
              { title: `${g.super_category} — SUPER CATEGORY SUBTOTAL`,
                columns: pdfCols, widths: pdfWidthsArr, rows: [pdfSubtotal('SUBTOTAL', g, 'super_category')] },
            ]),
            { title: 'GRAND TOTAL', columns: pdfCols, widths: pdfWidthsArr,
              rows: [pdfSubtotal('GRAND TOTAL', { ...grand, items: rows.length }, 'super_category')] }]
          : [{ title: withSystem ? 'Variance (Physical − System)' : 'Physical count',
               columns: pdfCols, widths: pdfWidthsArr, rows: rows.map(pdfRow) },
             { title: 'TOTAL', columns: pdfCols, widths: pdfWidthsArr,
               rows: [pdfSubtotal('TOTAL', { ...totals, items: rows.length }, 'super_category')] }]),
        // Summary report, mirroring the Excel second sheet: the same seven
        // columns, the super category printed once per block, one Grand Total.
        { title: 'Summary report — by category',
          columns: ['Super Category', 'Category', ...locations.map((l) => l.name),
                    'Total', 'ML / Loose', 'Final Total'],
          widths: [78, 78, ...locations.map(() => Math.max(30, Math.round(200 / Math.max(1, locations.length)))), 62, 58, 70],
          rows: [
            ...summary.superCategories.flatMap((g) =>
              summary.categories
                .filter((x) => x.super_category === g.super_category)
                .map((c, i) => [i === 0 ? c.super_category : '', c.category,
                  ...locations.map((_, k) => c.by_location?.[k] ?? 0),
                  c.location_total, c.loose_ml, c.final_total_qty])),
            ['Grand Total', '',
             ...locations.map((_, k) => summary.grand.by_location?.[k] ?? 0),
             summary.grand.location_total,
             summary.grand.loose_ml, summary.grand.final_total_qty],
          ],
          note: [
            `Total items ${summary.header.buckets.total}`,
            `ML ${summary.header.buckets.ml}`,
            `GM ${summary.header.buckets.gm}`,
            `KG ${summary.header.buckets.kg}`,
            `Count-based ${summary.header.buckets.count_based}`,
          ].join('  ·  ') },
      ],
    });
  }

  res.json({ audit, rows, groups, grand, summary, columns: cols, withSystem,
             provisional, progress, totals, hasSystemStock, provenance, notStocked,
             nilStock, locations });
});

// ── R5 Consolidated (all stores) ─────────────────────────────────────────────
router.get('/consolidated', async (req, res) => {
  const ids = String(req.query.audit_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'audit_ids required (comma separated)' });
  const { stores, superCategories } = await consolidated(ids);
  const anyProvisional = stores.some((d) => d.provisional);
  const format = req.query.format;
  const fname = `${anyProvisional ? 'PROVISIONAL_' : ''}R5_consolidated`;
  const stamp = anyProvisional
    ? 'PROVISIONAL — one or more audits are still in progress.' : null;
  const cols = ['Store', 'Date', 'Status', 'Items', 'Uncounted', 'Physical Value',
                'Total Variance Qty', 'Total Variance Value', 'Critical Items'];
  const toRow = (d) => [d.store_name, d.audit_date, d.status, d.items, d.uncounted,
                        d.physical_value, d.total_variance_qty, n(d.total_variance_value),
                        d.critical_items];
  // Super-category-level comparison across stores.
  const scCols = ['Super Category', 'Store', 'Items', 'Physical', 'System', 'Variance',
                  'Physical Value', 'Variance Value'];
  const scRow = (r) => [r.super_category, r.store_name, r.items, r.physical_qty,
                        r.system_qty, r.variance, n(r.physical_value), n(r.variance_value)];
  const scSorted = [...superCategories].sort(
    (a, b) => a.super_category.localeCompare(b.super_category) || a.store_name.localeCompare(b.store_name)
  );

  if (format === 'xlsx') {
    const header = stamp ? [['PROVISIONAL'], [stamp], []] : [];
    return sendXlsx(res, fname, [
      { name: 'By Store', aoa: [...header, cols, ...stores.map(toRow)] },
      { name: 'By Super Category', aoa: [...header, scCols, ...scSorted.map(scRow)] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: `R5 — Consolidated Report${anyProvisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: 'All selected stores', banner: stamp,
      blocks: [
        { title: 'Comparative by store', columns: cols,
          rows: stores.map((d) => [d.store_name, d.audit_date, d.status, d.items, d.uncounted,
            (d.physical_value || 0).toFixed(2), d.total_variance_qty, d.critical_items]) },
        { title: 'Comparative by super category', columns: scCols,
          rows: scSorted.map(scRow) },
      ],
    });
  }
  res.json({ rows: stores, superCategories: scSorted, provisional: anyProvisional });
});

// ── R6 Exception Report ──────────────────────────────────────────────────────
router.get('/exceptions/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await exceptionReport(req.params.auditId);
  const format = req.query.format;
  const fname = `R6_exceptions_${slug(audit.store_name)}`;
  const SC = ['Super Category', 'Category'];
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [
      { name: 'Voided', aoa: [[...SC, 'Item Name', 'Qty/Bottles', 'Open ml', 'Location', 'Void Reason', 'Counted By', 'Voided By'],
        ...data.voided.map((v) => [v.super_category, v.category, v.name, n(v.qty ?? v.bottles), n(v.open_ml), n(v.location_text), v.void_reason, v.counted_by_name, v.voided_by_name])] },
      { name: 'Not Applicable', aoa: [[...SC, 'Item Name', 'Reason', 'Marked By'],
        ...data.notApplicable.map((v) => [v.super_category, v.category, v.name, v.reason, v.marked_by_name])] },
      { name: 'Multiple Entries', aoa: [[...SC, 'Item Name', 'Entries', 'Physical Qty'],
        ...data.multiEntry.map((v) => [v.super_category, v.category, v.name, v.entries, v.physical_qty])] },
      { name: 'Zero Quantity', aoa: [[...SC, 'Item Name', 'Zero Entries'],
        ...data.zeroQty.map((v) => [v.super_category, v.category, v.name, v.zero_entries])] },
      { name: 'No Photo', aoa: [[...SC, 'Item Name', 'Entries'],
        ...data.noPhoto.map((v) => [v.super_category, v.category, v.name, v.entries])] },
      // A missing system figure is a DATA GAP, not a variance.
      { name: 'No System Data', aoa: [[...SC, 'Item Name', 'Unit', 'Physical Qty', 'Counted'],
        ...data.noSystemData.map((v) => [v.super_category, v.category, v.name, v.unit,
                                         v.physical_qty, v.counted ? 'Yes' : 'No'])] },
      // System stock exists and nobody counted it — a full shortage that has
      // not been looked at. Its own section because it needs chasing up.
      { name: 'Not Counted', aoa: [
        [`${data.notCounted.length} item(s) have system stock but no count was recorded. Each is a full shortage on the variance report.`],
        [`${data.notStockedCount} further master item(s) were neither counted nor present in system stock — not stocked at this outlet.`],
        [],
        [...SC, 'Item Name', 'Unit', 'System Qty', 'Shortage Qty', 'Shortage Value', 'Marked N/A'],
        ...data.notCounted.map((v) => [v.super_category, v.category, v.name, v.unit,
                                       v.system_qty, v.shortage_qty, n(v.shortage_value),
                                       v.not_applicable ? 'Yes' : ''])] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R6 — Exception Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [
        { title: 'Voided Entries', columns: [...SC, 'Item Name', 'Reason', 'Counted By', 'Voided By'],
          widths: [120, 75, 75, 110, 75, 78], rows: data.voided.map((v) => [v.super_category, v.category, v.name, v.void_reason, v.counted_by_name, v.voided_by_name]) },
        { title: 'Not Applicable', columns: [...SC, 'Item Name', 'Reason', 'Marked By'],
          widths: [130, 85, 85, 140, 83], rows: data.notApplicable.map((v) => [v.super_category, v.category, v.name, v.reason, v.marked_by_name]) },
        { title: 'Multiple Entries', columns: [...SC, 'Item Name', 'Entries', 'Physical Qty'],
          rows: data.multiEntry.map((v) => [v.super_category, v.category, v.name, v.entries, v.physical_qty]) },
        { title: 'Zero Quantity', columns: [...SC, 'Item Name', 'Zero Entries'],
          rows: data.zeroQty.map((v) => [v.super_category, v.category, v.name, v.zero_entries]) },
        { title: `No System Data (${data.noSystemData.length}) — data gap, not a variance`,
          columns: [...SC, 'Item Name', 'Physical Qty'],
          rows: data.noSystemData.map((v) => [v.super_category, v.category, v.name, v.physical_qty]) },
        { title: `Not Counted (${data.notCounted.length}) — system stock exists, no count recorded`,
          columns: [...SC, 'Item Name', 'System Qty', 'Shortage Qty', 'Shortage Value'],
          rows: data.notCounted.map((v) => [v.super_category, v.category, v.name,
                                            v.system_qty, v.shortage_qty, n(v.shortage_value)]),
          note: `Each of these is a full shortage on the variance report. A further ${data.notStockedCount} master item(s) were neither counted nor present in system stock — not stocked at this outlet.` },
        { title: 'Counted Without Photo', columns: [...SC, 'Item Name', 'Entries'],
          rows: data.noPhoto.map((v) => [v.super_category, v.category, v.name, v.entries]) },
      ],
    });
  }
  res.json({ audit, ...data });
});

export default router;
