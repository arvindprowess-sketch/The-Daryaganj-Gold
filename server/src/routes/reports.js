import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAudit, physicalSummary, itemDetail, liquorReport, varianceReport, consolidated, exceptionReport } from '../lib/reports.js';
import { buildWorkbook, buildPdf } from '../lib/exporters.js';

const router = Router();
// Reports are ADMIN ONLY (auditors have no reports, no rates).
router.use(requireAuth, requireRole('admin'));

const LIQUOR_FOOTNOTE = 'Open bottle quantities are recorded by visual estimation.';
const n = (v) => (v == null ? '' : v);

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

// ── R1 Physical Stock Summary ────────────────────────────────────────────────
router.get('/physical-summary/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await physicalSummary(req.params.auditId);
  const format = req.query.format;
  const sub = `${audit.store_name} — ${audit.audit_date}`;
  if (format === 'xlsx') {
    return sendXlsx(res, `R1_physical_summary_${audit.store_code}`, [
      { name: 'By Section', aoa: [['Section', 'Items', 'Quantity', 'Value'],
        ...data.sections.map((s) => [s.section, s.items, s.qty, s.value])] },
      { name: 'By Category', aoa: [['Section', 'Category', 'Items', 'Quantity', 'Value'],
        ...data.categories.map((c) => [c.section, c.category, c.items, c.qty, c.value])] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, `R1_physical_summary_${audit.store_code}`, {
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

// ── R2 Item Detail with entry breakdown ──────────────────────────────────────
router.get('/item-detail/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await itemDetail(req.params.auditId);
  const format = req.query.format;
  if (format === 'xlsx') {
    const aoa = [['Code', 'Item', 'Unit', 'Entry Qty/Bottles', 'Open ml', 'Location', 'By', 'Time', 'Status']];
    for (const it of data) {
      for (const e of it.entries) {
        aoa.push([it.code, it.name, it.unit,
          it.is_liquor ? n(e.bottles) : n(e.qty), it.is_liquor ? n(e.open_ml) : '',
          n(e.location_text), e.counted_by_name, new Date(e.counted_at).toLocaleString(),
          e.status === 'void' ? `VOID: ${e.void_reason || ''}` : 'active']);
      }
      aoa.push(['', `${it.name} TOTAL`, it.unit,
        it.is_liquor ? it.total_bottles : it.total_qty, it.is_liquor ? it.total_open_ml : '', '', '', '', '']);
    }
    return sendXlsx(res, `R2_item_detail_${audit.store_code}`, [{ name: 'Item Detail', aoa }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, `R2_item_detail_${audit.store_code}`, {
      title: 'R2 — Item Detail', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: data.map((it) => ({
        title: `${it.name} (${it.unit})`,
        columns: ['Qty', 'Location', 'By', 'Time', 'Status'],
        widths: [70, 180, 90, 120, 63],
        rows: it.entries.map((e) => [
          it.is_liquor ? `${n(e.bottles)} btl / ${n(e.open_ml)} ml` : n(e.qty),
          n(e.location_text), e.counted_by_name,
          new Date(e.counted_at).toLocaleTimeString(),
          e.status === 'void' ? 'VOID' : 'active',
        ]).concat([[`Total ${it.is_liquor ? it.total_bottles + ' btl' : it.total_qty}`, '', '', '', '']]),
      })),
    });
  }
  res.json({ audit, items: data });
});

// ── R3 Liquor Report ─────────────────────────────────────────────────────────
router.get('/liquor/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await liquorReport(req.params.auditId);
  const format = req.query.format;
  if (format === 'xlsx') {
    return sendXlsx(res, `R3_liquor_${audit.store_code}`, [{
      name: 'Liquor', aoa: [['Brand', 'Sealed Bottles', 'Open (ml)'],
        ...data.map((d) => [d.brand, d.sealed_bottles, d.open_ml]),
        [], ['Note:', LIQUOR_FOOTNOTE]],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, `R3_liquor_${audit.store_code}`, {
      title: 'R3 — Liquor Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [{ title: 'Liquor', columns: ['Brand', 'Sealed Bottles', 'Open (ml)'],
        widths: [280, 120, 123],
        rows: data.map((d) => [d.brand, d.sealed_bottles, d.open_ml]), note: LIQUOR_FOOTNOTE }],
    });
  }
  res.json({ audit, rows: data, footnote: LIQUOR_FOOTNOTE });
});

// ── R4 Variance Report ───────────────────────────────────────────────────────
router.get('/variance/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await varianceReport(req.params.auditId);
  const format = req.query.format;
  const cols = ['Code', 'Item', 'Unit', 'Physical', 'System', 'Variance', 'Variance %', 'Status'];
  if (format === 'xlsx') {
    return sendXlsx(res, `R4_variance_${audit.store_code}`, [{
      name: 'Variance', aoa: [cols, ...data.map((d) => [d.code, d.name, d.unit,
        d.physical_qty, n(d.system_qty), n(d.variance), n(d.variance_pct), d.status])],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, `R4_variance_${audit.store_code}`, {
      title: 'R4 — Variance Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [{ title: 'Variance (Physical − System)', columns: cols,
        widths: [55, 150, 40, 55, 55, 55, 55, 58],
        rows: data.map((d) => [d.code, d.name, d.unit, d.physical_qty, n(d.system_qty), n(d.variance), n(d.variance_pct), d.status]) }],
    });
  }
  res.json({ audit, rows: data });
});

// ── R5 Consolidated (all stores) ─────────────────────────────────────────────
router.get('/consolidated', async (req, res) => {
  const ids = String(req.query.audit_ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'audit_ids required (comma separated)' });
  const data = await consolidated(ids);
  const format = req.query.format;
  const cols = ['Store', 'Date', 'Status', 'Items', 'Physical Value', 'Total Variance Qty', 'Critical Items'];
  if (format === 'xlsx') {
    return sendXlsx(res, 'R5_consolidated', [{
      name: 'Consolidated', aoa: [cols, ...data.map((d) => [d.store_name, d.audit_date, d.status,
        d.items, d.physical_value, d.total_variance_qty, d.critical_items])],
    }]);
  }
  if (format === 'pdf') {
    return sendPdf(res, 'R5_consolidated', {
      title: 'R5 — Consolidated Report', subtitle: 'All selected stores',
      blocks: [{ title: 'Comparative', columns: cols,
        rows: data.map((d) => [d.store_name, d.audit_date, d.status, d.items,
          (d.physical_value || 0).toFixed(2), d.total_variance_qty, d.critical_items]) }],
    });
  }
  res.json({ rows: data });
});

// ── R6 Exception Report ──────────────────────────────────────────────────────
router.get('/exceptions/:auditId', async (req, res) => {
  const audit = await getAudit(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const data = await exceptionReport(req.params.auditId);
  const format = req.query.format;
  if (format === 'xlsx') {
    return sendXlsx(res, `R6_exceptions_${audit.store_code}`, [
      { name: 'Voided', aoa: [['Code', 'Item', 'Qty/Bottles', 'Open ml', 'Location', 'Void Reason', 'Counted By', 'Voided By'],
        ...data.voided.map((v) => [v.code, v.name, n(v.qty ?? v.bottles), n(v.open_ml), n(v.location_text), v.void_reason, v.counted_by_name, v.voided_by_name])] },
      { name: 'Not Applicable', aoa: [['Code', 'Item', 'Reason', 'Marked By'],
        ...data.notApplicable.map((v) => [v.code, v.name, v.reason, v.marked_by_name])] },
      { name: 'Multiple Entries', aoa: [['Code', 'Item', 'Entries', 'Physical Qty'],
        ...data.multiEntry.map((v) => [v.code, v.name, v.entries, v.physical_qty])] },
      { name: 'Zero Quantity', aoa: [['Code', 'Item', 'Zero Entries'],
        ...data.zeroQty.map((v) => [v.code, v.name, v.zero_entries])] },
      { name: 'No Photo', aoa: [['Code', 'Item', 'Entries'],
        ...data.noPhoto.map((v) => [v.code, v.name, v.entries])] },
    ]);
  }
  if (format === 'pdf') {
    return sendPdf(res, `R6_exceptions_${audit.store_code}`, {
      title: 'R6 — Exception Report', subtitle: `${audit.store_name} — ${audit.audit_date}`,
      blocks: [
        { title: 'Voided Entries', columns: ['Code', 'Item', 'Reason', 'Counted By', 'Voided By'],
          widths: [55, 150, 130, 90, 98], rows: data.voided.map((v) => [v.code, v.name, v.void_reason, v.counted_by_name, v.voided_by_name]) },
        { title: 'Not Applicable', columns: ['Code', 'Item', 'Reason', 'Marked By'],
          widths: [60, 170, 190, 103], rows: data.notApplicable.map((v) => [v.code, v.name, v.reason, v.marked_by_name]) },
        { title: 'Multiple Entries', columns: ['Code', 'Item', 'Entries', 'Physical Qty'],
          rows: data.multiEntry.map((v) => [v.code, v.name, v.entries, v.physical_qty]) },
        { title: 'Zero Quantity', columns: ['Code', 'Item', 'Zero Entries'],
          rows: data.zeroQty.map((v) => [v.code, v.name, v.zero_entries]) },
        { title: 'Counted Without Photo', columns: ['Code', 'Item', 'Entries'],
          rows: data.noPhoto.map((v) => [v.code, v.name, v.entries]) },
      ],
    });
  }
  res.json({ audit, ...data });
});

export default router;
