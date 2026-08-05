import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAudit, physicalSummary, itemDetailTotals, liquorReport,
  varianceReport, consolidated, exceptionReport,
} from '../lib/reports.js';
import { buildWorkbook, buildPdf } from '../lib/exporters.js';

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
  const { rows, groups, grand, provisional, progress, totals, hasSystemStock, provenance } =
    await varianceReport(req.params.auditId,
      { countedOnly, categoryId, superCategoryId, systemData, rateFilter });
  const format = req.query.format;

  // No system stock at all → do NOT render a table of 100% shortages. An empty
  // import must never be mistaken for a total shortage.
  if (!hasSystemStock) {
    const message = 'No system stock has been imported for this audit.';
    if (format === 'xlsx') {
      return sendXlsx(res, `R4_variance_${slug(audit.store_name)}`, [{
        name: 'Variance', aoa: [['NO SYSTEM STOCK'], [message],
          ['Import system stock for this audit before running a variance report.']],
      }]);
    }
    if (format === 'pdf') {
      return sendPdf(res, `R4_variance_${slug(audit.store_name)}`, {
        title: 'R4 — Variance Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
        banner: message,
        blocks: [{ title: 'No system stock', columns: ['Status'],
          rows: [['Import system stock for this audit before running a variance report.']] }],
      });
    }
    return res.json({
      audit, rows: [], groups: [], grand, provisional, progress,
      hasSystemStock: false, provenance, totals,
      message,
    });
  }

  const fname = `${provisional ? 'PROVISIONAL_' : ''}R4_variance_${slug(audit.store_name)}`;
  const stamp = provisional
    ? `PROVISIONAL — count in progress. ${progress.uncounted} of ${progress.total} items not yet counted.`
    : null;
  // Provenance — every export states where the system figures came from.
  const src = provenance.source;
  const provenanceLines = [
    `System stock source: ${src?.filename || 'entered manually'}`,
    src ? `Imported: ${new Date(src.imported_at).toLocaleString()}${src.imported_by_name ? ' by ' + src.imported_by_name : ''}` : null,
    `Coverage: ${provenance.with_system} of ${provenance.master_total} master items`,
    totals.no_system_data > 0
      ? `${totals.no_system_data} item(s) shown as NO SYSTEM DATA and excluded from variance totals`
      : null,
    // The value columns cannot speak for an item with no rate, so the export
    // says how many there are rather than letting the reader assume zero.
    totals.no_rate > 0
      ? `${totals.no_rate} item(s) have no rate — value figures exclude them`
      : null,
  ].filter(Boolean);

  // Standard column order: Super Category | Category | Item Name | Unit | …
  // Rate and the two rupee columns are what make this a variance report rather
  // than a count comparison: negative variance value = shortage.
  const cols = ['Super Category', 'Category', 'Item Name', 'Unit', 'Rate', 'Physical',
                'System', 'Variance', 'Variance %', 'Physical Value', 'Variance Value',
                'Status'];
  const toRow = (d) => [d.super_category, d.category, d.name, d.unit, n(d.rate),
                        d.physical_qty, n(d.system_qty), n(d.variance), n(d.variance_pct),
                        n(d.physical_value), n(d.variance_value), d.status];

  // A subtotal / total line carries every figure a row carries, in the same
  // columns, so it can be read straight down the page.
  const summaryRow = (label, b, labelCol = 1) => {
    const r = ['', '', '', '', '', b.physical_qty, b.system_qty, b.variance,
               n(b.variance_pct), n(b.physical_value), n(b.variance_value),
               `${b.items} items`];
    r[labelCol] = label;
    return r;
  };

  if (format === 'xlsx') {
    const aoa = [];
    if (stamp) aoa.push(['PROVISIONAL'], [stamp], []);
    // Provenance always precedes the figures.
    provenanceLines.forEach((l) => aoa.push([l]));
    aoa.push([]);
    aoa.push(cols);
    if (grouped) {
      // Subtotals at category and super category level, then a grand total.
      for (const g of groups) {
        for (const c of g.categories) {
          aoa.push(...c.rows.map(toRow));
          aoa.push(summaryRow(`${c.category} — SUBTOTAL`, c));
        }
        aoa.push(summaryRow(`${g.super_category} — SUPER CATEGORY SUBTOTAL`, g, 0));
        aoa.push([]);
      }
      aoa.push(summaryRow('GRAND TOTAL', grand, 0));
    } else {
      aoa.push(...rows.map(toRow));
    }
    // Overall totals — computed only over rows that have a system figure.
    aoa.push([]);
    // `totals` counts its rows as with_system; the summary row wants `items`.
    aoa.push(summaryRow('TOTAL (rows with system data only)',
                        { ...totals, items: totals.with_system }, 0));
    if (totals.no_system_data > 0) {
      aoa.push([`${totals.no_system_data} item(s) with NO SYSTEM DATA — excluded from the totals above`]);
    }
    if (totals.no_rate > 0) {
      aoa.push([`${totals.no_rate} item(s) have no rate — value figures exclude them`]);
    }
    return sendXlsx(res, fname, [{ name: 'Variance', aoa }]);
  }
  if (format === 'pdf') {
    const widths = [70, 70, 105, 50, 40, 45, 45, 45, 40, 60, 60, 50];
    // Overall totals, excluding rows with no system figure.
    const totalsBlock = {
      title: 'Totals (rows with system data only)',
      columns: ['Items', 'Physical', 'System', 'Variance', 'Variance %',
                'Physical Value', 'Variance Value'],
      rows: [[totals.with_system, totals.physical_qty, totals.system_qty,
              totals.variance, n(totals.variance_pct),
              n(totals.physical_value), n(totals.variance_value)]],
      note: [
        totals.no_system_data > 0
          ? `${totals.no_system_data} item(s) with NO SYSTEM DATA are excluded from these totals.` : null,
        totals.no_rate > 0
          ? `${totals.no_rate} item(s) have no rate — value figures exclude them.` : null,
      ].filter(Boolean).join(' ') || null,
    };
    return sendPdf(res, fname, {
      title: `R4 — Variance Report${provisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: `${audit.store_name} — ${audit.audit_date}\n${provenanceLines.join('\n')}`,
      banner: stamp,
      blocks: grouped
        ? [...groups.flatMap((g) => [
            ...g.categories.map((c) => ({
              title: `${g.super_category} › ${c.category}`,
              columns: cols, widths,
              rows: [...c.rows.map(toRow), summaryRow('SUBTOTAL', c)],
            })),
            { title: `${g.super_category} — SUPER CATEGORY SUBTOTAL`,
              columns: ['Items', 'Physical', 'System', 'Variance', 'Variance %',
                        'Physical Value', 'Variance Value'],
              rows: [[g.items, g.physical_qty, g.system_qty, g.variance, n(g.variance_pct),
                      n(g.physical_value), n(g.variance_value)]] },
          ]),
          { title: 'GRAND TOTAL',
            columns: ['Items', 'Physical', 'System', 'Variance', 'Variance %',
                      'Physical Value', 'Variance Value'],
            rows: [[grand.items, grand.physical_qty, grand.system_qty, grand.variance,
                    n(grand.variance_pct), n(grand.physical_value), n(grand.variance_value)]] },
          totalsBlock]
        : [{ title: 'Variance (Physical − System)', columns: cols, widths, rows: rows.map(toRow) },
           totalsBlock],
    });
  }
  res.json({ audit, rows, groups, grand, provisional, progress, totals, hasSystemStock, provenance });
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
        { title: 'Counted Without Photo', columns: [...SC, 'Item Name', 'Entries'],
          rows: data.noPhoto.map((v) => [v.super_category, v.category, v.name, v.entries]) },
      ],
    });
  }
  res.json({ audit, ...data });
});

export default router;
