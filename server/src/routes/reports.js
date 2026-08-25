import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAudit, physicalSummary, itemDetailTotals, liquorReport,
  varianceReport, consolidated, exceptionReport,
} from '../lib/reports.js';
import { buildWorkbook, buildPdf } from '../lib/exporters.js';
import { buildAuditWorkbook } from '../lib/auditWorkbook.js';

const router = Router();
// Reports are ADMIN ONLY (auditors have no reports, no rates).
router.use(requireAuth, requireRole('admin'));

const LIQUOR_FOOTNOTE = 'Open bottle quantities are recorded by visual estimation.';
const n = (v) => (v == null ? '' : v);

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

// A DATE column comes back from pg as a Date. Reports want the plain calendar
// day, not "Wed Aug 05 2026 00:00:00 GMT+0000".
const ymd = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

// ── R1 Physical Stock Summary ────────────────────────────────────────────────
router.get('/physical-summary/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await physicalSummary(req.params.auditId);
  const format = req.query.format;
  const sub = `${audit.store_name} — ${audit.audit_date}`;
  const fname = `R1_physical_summary_${slug(audit.store_name)}`;
  // Grouped super category → category, with a subtotal per category, a subtotal
  // per super category, and a grand total.
  const cols = ['Super Category', 'Category', 'Items', 'Quantity', 'Value'];
  const groupedAoa = () => {
    const aoa = [cols];
    for (const g of data.groups) {
      for (const c of g.categories) {
        aoa.push([g.super_category, c.category, c.items, c.qty, Number(c.value.toFixed(2))]);
      }
      aoa.push([`${g.super_category} — SUBTOTAL`, '', g.items, g.qty, Number(g.value.toFixed(2))]);
      aoa.push([]);
    }
    aoa.push(['GRAND TOTAL', '', data.grand.items, data.grand.qty, Number(data.grand.value.toFixed(2))]);
    return aoa;
  };

  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{ name: 'Physical Summary', aoa: groupedAoa() }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R1 — Physical Stock Summary', subtitle: sub,
      blocks: [
        ...data.groups.map((g) => ({
          title: g.super_category,
          columns: ['Category', 'Items', 'Quantity', 'Value'],
          rows: [
            ...g.categories.map((c) => [c.category, c.items, c.qty, c.value.toFixed(2)]),
            ['SUBTOTAL', g.items, g.qty, g.value.toFixed(2)],
          ],
        })),
        { title: 'Grand total', columns: ['Items', 'Quantity', 'Value'],
          rows: [[data.grand.items, data.grand.qty, data.grand.value.toFixed(2)]] },
      ],
    });
  }
  res.json({ audit, ...data });
});

// ── R2 Item Detail — TOTALS ONLY, with Section and Category ─────────────────
router.get('/item-detail/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const rows = await itemDetailTotals(req.params.auditId);
  const format = req.query.format;
  const fname = `R2_item_detail_${slug(audit.store_name)}`;
  // Standard column order: Super Category | Category | Item Name | Unit | …
  const cols = ['Super Category', 'Category', 'Item Name', 'Unit', 'Total Qty', 'Open (ml)'];
  const toRow = (r) => [
    r.super_category, r.category, r.name, r.unit,
    r.not_applicable ? 'N/A' : (r.is_liquor ? r.total_bottles : r.total_qty),
    r.is_liquor ? r.total_open_ml : '',
  ];
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{ name: 'Item Detail', aoa: [cols, ...rows.map(toRow)] }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R2 — Item Detail', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [{ title: 'Totals by item', columns: cols,
        widths: [90, 90, 140, 70, 60, 50], rows: rows.map(toRow), note: LIQUOR_FOOTNOTE }],
    });
  }
  res.json({ audit, rows });
});

// ── R3 Liquor Report ─────────────────────────────────────────────────────────
router.get('/liquor/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await liquorReport(req.params.auditId);
  const format = req.query.format;
  const fname = `R3_liquor_${slug(audit.store_name)}`;
  // Structure unchanged — bottles and ml stay in separate columns and are
  // never combined. Super category / category added for consistency.
  const cols = ['Super Category', 'Category', 'Brand', 'Unit', 'Sealed Bottles', 'Open (ml)'];
  const toRow = (d) => [d.super_category, d.category, d.brand, d.unit, d.sealed_bottles, d.open_ml];
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{
      name: 'Liquor', aoa: [cols, ...data.map(toRow), [], ['Note:', LIQUOR_FOOTNOTE]],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R3 — Liquor Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [{ title: 'Liquor', columns: cols,
        widths: [80, 80, 160, 70, 70, 63],
        rows: data.map(toRow), note: LIQUOR_FOOTNOTE }],
    });
  }
  res.json({ audit, rows: data, footnote: LIQUOR_FOOTNOTE });
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
          provenance, notStocked, nilStock } =
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
  const BASE_COLS = ['S.No.', 'LOC', 'Super Category', 'Category', 'Item Name', 'Unit',
                     'Bottle/Unit Size (ml)', 'Store Room Qty (Physical)',
                     'Outlet Qty (Physical)', 'Store+Outlet Total (native unit)',
                     'ML / Loose Qty (Open Bottle, ml)',
                     'Final Total Qty (ML / GM / KG / Count)', 'Remarks'];
  const SYSTEM_COLS = ['System Qty', 'Rate', 'Value', 'Variance', 'Variance Value'];
  const cols = withSystem ? [...BASE_COLS, ...SYSTEM_COLS] : BASE_COLS;

  if (format === 'xlsx') {
    return sendXlsx(res, fname, buildAuditWorkbook({
      audit, rows, groups, grand, summary, totals, withSystem, grouped, stamp,
      headerLines, cols, nilStock,
    }));
  }

  if (format === 'pdf') {
    // 13 (or 18) columns will not fit A4 portrait legibly, so the PDF carries
    // the identifying columns plus the quantity columns; the Excel export is
    // the full-fidelity deliverable.
    const pdfCols = withSystem
      ? ['S.No.', 'Item Name', 'Unit', 'Size', 'Store', 'Outlet', 'Total', 'Loose ML',
         'Final Total', 'Remarks', 'System', 'Variance', 'Var Value']
      : ['S.No.', 'Item Name', 'Unit', 'Size', 'Store', 'Outlet', 'Total', 'Loose ML',
         'Final Total', 'Remarks'];
    const pdfWidths = withSystem
      ? [26, 96, 52, 34, 34, 34, 38, 38, 48, 42, 38, 38, 46]
      : [30, 150, 70, 44, 44, 44, 50, 50, 62, 58];
    const pdfRow = (d) => {
      const base = [d.s_no, d.name, d.unit, d.bottle_unit_size, d.store_room_qty,
                    d.outlet_qty, d.store_outlet_total, d.loose_ml, d.final_total_qty,
                    d.not_counted ? `${d.remarks} · NOT COUNTED` : d.remarks];
      return withSystem
        ? [...base, n(d.system_qty), n(d.variance), n(d.variance_value)]
        : base;
    };
    const pdfSubtotal = (label, b) => {
      const base = ['', label, '', '', b.store_room_qty, b.outlet_qty, b.store_outlet_total,
                    b.loose_ml, b.final_total_qty, `${b.items} items`];
      return withSystem ? [...base, b.system_qty, b.variance, n(b.variance_value)] : base;
    };
    return sendPdf(res, fname, {
      title: `R4 — ${withSystem ? 'Variance Report' : 'Physical Audit Report'}${provisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: `${audit.store_name} — ${ymd(audit.audit_date)}\n${headerLines.join('\n')}`,
      banner: stamp,
      blocks: [
        ...(grouped
          ? [...groups.flatMap((g) => [
              ...g.categories.map((c) => ({
                title: `${g.super_category} › ${c.category}`,
                columns: pdfCols, widths: pdfWidths,
                rows: [...c.rows.map(pdfRow), pdfSubtotal('SUBTOTAL', c)],
              })),
              { title: `${g.super_category} — SUPER CATEGORY SUBTOTAL`,
                columns: pdfCols, widths: pdfWidths, rows: [pdfSubtotal('SUBTOTAL', g)] },
            ]),
            { title: 'GRAND TOTAL', columns: pdfCols, widths: pdfWidths,
              rows: [pdfSubtotal('GRAND TOTAL', grand)] }]
          : [{ title: withSystem ? 'Variance (Physical − System)' : 'Physical count',
               columns: pdfCols, widths: pdfWidths, rows: rows.map(pdfRow) },
             { title: 'TOTAL', columns: pdfCols, widths: pdfWidths,
               rows: [pdfSubtotal('TOTAL', { ...totals, items: rows.length })] }]),
        // Summary report, mirroring the Excel second sheet: the same seven
        // columns, the super category printed once per block, one Grand Total.
        { title: 'Summary report — by category',
          columns: ['Super Category', 'Category', 'Store Room', 'Outlet',
                    'Store+Outlet', 'ML / Loose', 'Final Total'],
          widths: [78, 78, 62, 58, 66, 58, 70],
          rows: [
            ...summary.superCategories.flatMap((g) =>
              summary.categories
                .filter((x) => x.super_category === g.super_category)
                .map((c, i) => [i === 0 ? c.super_category : '', c.category,
                  c.store_room_qty, c.outlet_qty, c.store_outlet_total,
                  c.loose_ml, c.final_total_qty])),
            ['Grand Total', '', summary.grand.store_room_qty,
             summary.grand.outlet_qty, summary.grand.store_outlet_total,
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
             nilStock });
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
