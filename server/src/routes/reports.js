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

function sendXlsx(res, filename, sheets) {
  const buf = buildWorkbook(sheets);
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
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [
      { name: 'By Section', aoa: [['Section', 'Items', 'Quantity', 'Value'],
        ...data.sections.map((s) => [s.section, s.items, s.qty, s.value])] },
      { name: 'By Category', aoa: [['Section', 'Category', 'Items', 'Quantity', 'Value'],
        ...data.categories.map((c) => [c.section, c.category, c.items, c.qty, c.value])] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R1 — Physical Stock Summary', subtitle: sub,
      blocks: [
        { title: 'By Section', columns: ['Section', 'Items', 'Quantity', 'Value'],
          rows: data.sections.map((s) => [s.section, s.items, s.qty, s.value.toFixed(2)]) },
        { title: 'By Category', columns: ['Section', 'Category', 'Items', 'Qty', 'Value'],
          rows: data.categories.map((c) => [c.section, c.category, c.items, c.qty, c.value.toFixed(2)]) },
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
  const cols = ['Item', 'Section', 'Category', 'Unit', 'Total Qty', 'Open (ml)'];
  const toRow = (r) => [
    r.name, r.section, r.category, r.unit,
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
        widths: [150, 110, 110, 50, 60, 50], rows: rows.map(toRow), note: LIQUOR_FOOTNOTE }],
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
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [{
      name: 'Liquor', aoa: [['Brand', 'Sealed Bottles', 'Open (ml)'],
        ...data.map((d) => [d.brand, d.sealed_bottles, d.open_ml]),
        [], ['Note:', LIQUOR_FOOTNOTE]],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R3 — Liquor Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [{ title: 'Liquor', columns: ['Brand', 'Sealed Bottles', 'Open (ml)'],
        widths: [280, 120, 123],
        rows: data.map((d) => [d.brand, d.sealed_bottles, d.open_ml]), note: LIQUOR_FOOTNOTE }],
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
  const { rows, provisional, progress } = await varianceReport(req.params.auditId, { countedOnly });
  const format = req.query.format;
  const fname = `${provisional ? 'PROVISIONAL_' : ''}R4_variance_${slug(audit.store_name)}`;
  const stamp = provisional
    ? `PROVISIONAL — count in progress. ${progress.uncounted} of ${progress.total} items not yet counted.`
    : null;
  const cols = ['Item', 'Unit', 'Physical', 'System', 'Variance', 'Variance %', 'Counted', 'Status'];
  const toRow = (d) => [d.name, d.unit, d.physical_qty, n(d.system_qty), n(d.variance),
                        n(d.variance_pct), d.counted ? 'Yes' : 'No', d.status];
  if (format === 'xlsx') {
    const header = [];
    if (stamp) header.push(['PROVISIONAL'], [stamp], []);
    return sendXlsx(res, fname, [{
      name: 'Variance', aoa: [...header, cols, ...rows.map(toRow)],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: `R4 — Variance Report${provisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: `${audit.store_name} — ${audit.audit_date}`,
      banner: stamp,
      blocks: [{ title: 'Variance (Physical − System)', columns: cols,
        widths: [150, 45, 55, 55, 55, 55, 45, 63], rows: rows.map(toRow) }],
    });
  }
  res.json({ audit, rows, provisional, progress });
});

// ── R5 Consolidated (all stores) ─────────────────────────────────────────────
router.get('/consolidated', async (req, res) => {
  const ids = String(req.query.audit_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'audit_ids required (comma separated)' });
  const data = await consolidated(ids);
  const anyProvisional = data.some((d) => d.provisional);
  const format = req.query.format;
  const fname = `${anyProvisional ? 'PROVISIONAL_' : ''}R5_consolidated`;
  const stamp = anyProvisional
    ? 'PROVISIONAL — one or more audits are still in progress.' : null;
  const cols = ['Store', 'Date', 'Status', 'Items', 'Uncounted', 'Physical Value', 'Total Variance Qty', 'Critical Items'];
  const toRow = (d) => [d.store_name, d.audit_date, d.status, d.items, d.uncounted,
                        d.physical_value, d.total_variance_qty, d.critical_items];
  if (format === 'xlsx') {
    const header = stamp ? [['PROVISIONAL'], [stamp], []] : [];
    return sendXlsx(res, fname, [{ name: 'Consolidated', aoa: [...header, cols, ...data.map(toRow)] }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: `R5 — Consolidated Report${anyProvisional ? ' (PROVISIONAL)' : ''}`,
      subtitle: 'All selected stores', banner: stamp,
      blocks: [{ title: 'Comparative', columns: cols,
        rows: data.map((d) => [d.store_name, d.audit_date, d.status, d.items, d.uncounted,
          (d.physical_value || 0).toFixed(2), d.total_variance_qty, d.critical_items]) }],
    });
  }
  res.json({ rows: data, provisional: anyProvisional });
});

// ── R6 Exception Report ──────────────────────────────────────────────────────
router.get('/exceptions/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await exceptionReport(req.params.auditId);
  const format = req.query.format;
  const fname = `R6_exceptions_${slug(audit.store_name)}`;
  if (format === 'xlsx') {
    return sendXlsx(res, fname, [
      { name: 'Voided', aoa: [['Item', 'Qty/Bottles', 'Open ml', 'Location', 'Void Reason', 'Counted By', 'Voided By'],
        ...data.voided.map((v) => [v.name, n(v.qty ?? v.bottles), n(v.open_ml), n(v.location_text), v.void_reason, v.counted_by_name, v.voided_by_name])] },
      { name: 'Not Applicable', aoa: [['Item', 'Reason', 'Marked By'],
        ...data.notApplicable.map((v) => [v.name, v.reason, v.marked_by_name])] },
      { name: 'Multiple Entries', aoa: [['Item', 'Entries', 'Physical Qty'],
        ...data.multiEntry.map((v) => [v.name, v.entries, v.physical_qty])] },
      { name: 'Zero Quantity', aoa: [['Item', 'Zero Entries'],
        ...data.zeroQty.map((v) => [v.name, v.zero_entries])] },
      { name: 'No Photo', aoa: [['Item', 'Entries'],
        ...data.noPhoto.map((v) => [v.name, v.entries])] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, fname, {
      title: 'R6 — Exception Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [
        { title: 'Voided Entries', columns: ['Item', 'Reason', 'Counted By', 'Voided By'],
          widths: [160, 150, 105, 108], rows: data.voided.map((v) => [v.name, v.void_reason, v.counted_by_name, v.voided_by_name]) },
        { title: 'Not Applicable', columns: ['Item', 'Reason', 'Marked By'],
          widths: [180, 240, 103], rows: data.notApplicable.map((v) => [v.name, v.reason, v.marked_by_name]) },
        { title: 'Multiple Entries', columns: ['Item', 'Entries', 'Physical Qty'],
          rows: data.multiEntry.map((v) => [v.name, v.entries, v.physical_qty]) },
        { title: 'Zero Quantity', columns: ['Item', 'Zero Entries'],
          rows: data.zeroQty.map((v) => [v.name, v.zero_entries]) },
        { title: 'Counted Without Photo', columns: ['Item', 'Entries'],
          rows: data.noPhoto.map((v) => [v.name, v.entries]) },
      ],
    });
  }
  res.json({ audit, ...data });
});

export default router;
