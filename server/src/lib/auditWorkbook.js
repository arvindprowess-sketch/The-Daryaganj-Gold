// ═══════════════════════════════════════════════════════════════════════════
// The R4 workbook, laid out to the firm's standard audit report.
//
// Two sheets, in this order:
//
//   1. "Summary report" — a horizontal header block (item counts by
//      measurement basis, date, location), one row per category under its
//      super category, a single Grand Total, and the Notes / Methodology
//      block that explains how the figures were arrived at.
//   2. "Audit Detail"   — the item-level table.
//
// The detail sheet is built to a FIXED geometry, because the LIVE TOTAL row
// addresses the data block by cell reference:
//
//   row 1   venue title
//   row 2   basis + provenance
//   row 3   blank
//   row 4   LIVE TOTAL — SUBTOTAL() formulas
//   row 5   column headers
//   row 6+  data
//
// Nothing may be inserted above row 6. The PROVISIONAL stamp and every
// provenance line therefore fold into row 2 rather than pushing the table
// down; the geometry is load-bearing, the header text is not.
//
// Quantities are written as live formulas WITH their computed result cached.
// The cached value means the file reads correctly in anything that does not
// evaluate formulas (Google Sheets preview, Numbers, a PDF print); the formula
// means an auditor who corrects a count in Excel sees every total follow.
// ═══════════════════════════════════════════════════════════════════════════

const FIRST_DATA_ROW = 6;

// Column positions the formulas depend on. 1-based, matching Excel.
const C = {
  size: 7,        // G — Bottle/Unit Size
  storeRoom: 8,   // H
  outlet: 9,      // I
  total: 10,      // J — Store+Outlet Total
  loose: 11,      // K — ML / Loose Qty
  final: 12,      // L — Final Total Qty
  remarks: 13,    // M
};
// The quantity columns the LIVE TOTAL and every subtotal sum over.
const QTY_COLS = [C.storeRoom, C.outlet, C.total, C.loose, C.final];
// With system stock: System Qty (N), Value (P), Variance (Q), Variance Value
// (R). Rate (O) is deliberately absent — summing a price list is meaningless.
const SYS_SUM_COLS = [14, 16, 17, 18];

function colLetter(i) {
  let s = '';
  let n = i;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

// 0 is not a measurement, it is the absence of one. The standard report leaves
// those cells empty so the eye lands on the rows that actually hold stock.
const blank = (v) => (Number(v) ? Number(v) : null);

const cell = (formula, result) => ({ formula, result: result == null ? 0 : Number(result) });

const ymd = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const NOTES = [
  '1. This report includes only items with physical stock (Store Room, Outlet, or open-bottle ML > 0). Nil-stock items are excluded, except where system stock exists for them.',
  '2. "Store+Outlet Total" = Store Room Qty + Outlet Qty, in the item\'s native counting unit (bottles/packs/pieces).',
  '3. "Final Total Qty" = (Store+Outlet) × Bottle/Unit Size + ML for items tracked by volume/weight per pack (e.g. liquor, syrups) — converting the count of closed bottles/packs plus any open/loose quantity into one true ML or GM figure. For items counted as whole units (cans, packets, portions, pieces) or bulk-weighed items (KG), Bottle/Unit Size is 1 and Final Total Qty = Store+Outlet as-is.',
  '4. "Remarks" shows what the Final Total Qty is actually measured in for that row: ML, GM, KG, or a count unit (Nos/Pkt/Por/Piece/Meter).',
  '5. The "LIVE TOTAL" row on the Audit Detail sheet uses SUBTOTAL formulas, so it updates automatically to reflect only the rows visible when a filter is applied.',
];

export function buildAuditWorkbook({
  audit, rows, groups, grand, summary, totals, withSystem, grouped, stamp,
  headerLines, cols, nilStock,
}) {
  const lastCol = cols.length;
  const sumCols = withSystem ? [...QTY_COLS, ...SYS_SUM_COLS] : QTY_COLS;

  // ── Detail sheet ─────────────────────────────────────────────────────────
  const aoa = [];
  const pad = (row) => { while (row.length < lastCol) row.push(null); return row; };
  const push = (row) => { aoa.push(pad(row)); return aoa.length; }; // → 1-based row number

  const title = `${(audit.store_name || '').toUpperCase()} — PHYSICAL ${withSystem ? 'STOCK VARIANCE' : 'STOCK AUDIT'} REPORT`;
  const basis = withSystem
    ? 'Physical Count basis: Store Room + Outlet + Open/Loose Bottle (ML)  |  Compared against imported system stock'
    : 'Physical Count basis: Store Room + Outlet + Open/Loose Bottle (ML)  |  No system stock used';
  // Everything the reader needs to trust the numbers, on one line, so the data
  // block stays anchored at row 6.
  const subtitle = [stamp, basis, ...headerLines].filter(Boolean).join('  |  ');

  push([title]);
  push([subtitle]);
  push([]);

  // Row 4 — LIVE TOTAL. SUBTOTAL(9, …) sums the VISIBLE rows only, and ignores
  // any nested SUBTOTAL, so the subtotal rows further down are never counted
  // twice. Placed above the header so it stays on screen while scrolling.
  const liveRow = [];
  liveRow[C.size - 1] = 'LIVE TOTAL';
  const totalFor = (c) => ({
    [C.storeRoom]: totals.store_room_qty, [C.outlet]: totals.outlet_qty,
    [C.total]: totals.store_outlet_total, [C.loose]: totals.loose_ml,
    [C.final]: totals.final_total_qty, 14: totals.system_qty, 16: totals.physical_value,
    17: totals.variance, 18: totals.variance_value,
  }[c]);
  for (const c of sumCols) {
    const L = colLetter(c);
    liveRow[c - 1] = cell(`SUBTOTAL(9,${L}${FIRST_DATA_ROW}:${L}1048576)`, totalFor(c));
  }
  for (let i = 0; i < lastCol; i++) if (liveRow[i] === undefined) liveRow[i] = null;
  push(liveRow);

  push([...cols]);

  // A data row's two computed cells reference only its own row, so inserting
  // subtotal rows between blocks cannot disturb them.
  const dataRow = (d, r) => {
    const base = [
      d.s_no, d.loc, d.super_category, d.category, d.name, d.unit,
      d.bottle_unit_size,
      blank(d.store_room_qty), blank(d.outlet_qty),
      cell(`H${r}+I${r}`, d.store_outlet_total),
      blank(d.loose_ml),
      cell(`IF(G${r}="",H${r}+I${r},(H${r}+I${r})*G${r}+K${r})`, d.final_total_qty),
      // NOT COUNTED rides alongside the measurement basis rather than
      // replacing it, so neither piece of information is lost.
      d.not_counted ? `${d.remarks} · NOT COUNTED` : d.remarks,
    ];
    if (!withSystem) return base;
    const num = (v) => (v == null ? null : Number(v));
    return [...base, num(d.system_qty), num(d.rate), num(d.physical_value),
            num(d.variance), num(d.variance_value)];
  };

  // A subtotal sums its own block with SUBTOTAL, for the same reason the LIVE
  // TOTAL does: it follows the filter, and the totals above it skip it.
  const subtotal = (label, bucket, from, to, labelCol) => {
    const r = [];
    r[labelCol - 1] = label;
    r[C.remarks - 1] = `${bucket.items} items`;
    const val = (c) => ({
      [C.storeRoom]: bucket.store_room_qty, [C.outlet]: bucket.outlet_qty,
      [C.total]: bucket.store_outlet_total, [C.loose]: bucket.loose_ml,
      [C.final]: bucket.final_total_qty, 14: bucket.system_qty,
      16: bucket.physical_value, 17: bucket.variance, 18: bucket.variance_value,
    }[c]);
    for (const c of sumCols) {
      const L = colLetter(c);
      r[c - 1] = cell(`SUBTOTAL(9,${L}${from}:${L}${to})`, val(c));
    }
    for (let i = 0; i < lastCol; i++) if (r[i] === undefined) r[i] = null;
    return r;
  };

  if (grouped) {
    for (const g of groups) {
      const gFrom = aoa.length + 1;
      for (const c of g.categories) {
        const cFrom = aoa.length + 1;
        for (const d of c.rows) push(dataRow(d, aoa.length + 1));
        push(subtotal(`${c.category} — SUBTOTAL`, c, cFrom, aoa.length, 4));
      }
      push(subtotal(`${g.super_category} — SUPER CATEGORY SUBTOTAL`, g, gFrom, aoa.length, 3));
      push([]);
    }
    push(subtotal('GRAND TOTAL', { ...grand, items: rows.length }, FIRST_DATA_ROW, aoa.length, 3));
  } else {
    for (const d of rows) push(dataRow(d, aoa.length + 1));
    push([]);
    push(subtotal('TOTAL', { ...totals, items: rows.length }, FIRST_DATA_ROW, aoa.length, 3));
  }

  push([]);
  if (withSystem && totals.no_system_data > 0) {
    push([`${totals.no_system_data} item(s) with NO SYSTEM DATA — excluded from the variance totals above`]);
  }
  if (withSystem && totals.no_rate > 0) {
    push([`${totals.no_rate} item(s) have no rate — value figures exclude them`]);
  }
  if (nilStock?.count > 0) {
    push([`${nilStock.count} item(s) counted at nil with no system figure — excluded on the "physical stock only" basis (add include_nil=1 to list them)`]);
  }

  // ── Summary sheet ────────────────────────────────────────────────────────
  const SUM_COLS = ['Super Category', 'Category', 'Store Room Qty (Physical)',
                    'Outlet Qty (Physical)', 'Store+Outlet Total (native unit)',
                    'ML / Loose Qty (Open Bottle, ml)',
                    'Final Total Qty (ML / GM / KG / Count)'];
  const h = summary.header;
  const b = h.buckets;
  const sum = [
    ['AUDIX SOLUTIONS & CO.'],
    [`${(audit.store_name || '').toUpperCase()} — PHYSICAL AUDIT SUMMARY`],
    [[stamp, `Closing stock — ${ymd(h.audit_date)}`,
      'Items with physical stock only (nil-stock items already excluded)'].filter(Boolean).join('  |  ')],
    // The header block reads across, not down: five counts, then the date and
    // location on the right. Counts are written as values rather than
    // COUNTIF formulas because grouping interleaves subtotal rows into the
    // detail block, and a range count would take those in too.
    ['Total Items in Report', 'Liquid Items (ML)', 'Weight Items (GM)',
     'Weight Items (KG)', 'Count-based Items (Nos/Pkt/Por/etc.)', 'DATE', ymd(h.audit_date)],
    [b.total, b.ml, b.gm, b.kg, b.count_based, 'LOCATION', h.location || h.store_name],
    SUM_COLS,
  ];
  // The super category is printed on its first category and left blank after,
  // so the eye groups the rows without a heading line breaking the table.
  for (const g of summary.superCategories) {
    let first = true;
    for (const c of summary.categories.filter((x) => x.super_category === g.super_category)) {
      sum.push([first ? c.super_category : null, c.category, blank(c.store_room_qty),
                blank(c.outlet_qty), blank(c.store_outlet_total), blank(c.loose_ml),
                blank(c.final_total_qty)]);
      first = false;
    }
  }
  const gt = summary.grand;
  sum.push(['Grand Total', null, blank(gt.store_room_qty), blank(gt.outlet_qty),
            blank(gt.store_outlet_total), blank(gt.loose_ml), blank(gt.final_total_qty)]);
  sum.push([]);
  sum.push(['Notes / Methodology:']);
  NOTES.forEach((t) => sum.push([t]));

  return [
    { name: 'Summary report', aoa: sum },
    { name: 'Audit Detail', aoa },
  ];
}
