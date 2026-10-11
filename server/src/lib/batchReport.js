// ═══════════════════════════════════════════════════════════════════════════
// Batch-wise report for one audit (warehouse).
//
// ONE function produces the rows that the Stock screen, the CSV download and
// both Excel workbooks show. They cannot disagree about which batches or
// entries exist, because there is only one query to disagree with.
//
// What it reads follows the same rule as every other report: the submitted
// snapshot once there is one, the live count before anything is submitted,
// nothing at all when the submission was cleared.
//
// Nothing is filtered out for being unusual. A batch created by a counter
// during the audit, a retired batch somebody counted, an entry against an
// article with no batch — every one of them is a row. A report that drops a
// count because the stock list changed underneath it is a report that lies.
// ═══════════════════════════════════════════════════════════════════════════
import { query } from '../db.js';
import { auditSource, submissionIds, SNAPSHOT, CLEARED } from './submissions.js';

const r3 = (n) => Number(Number(n).toFixed(3));

export async function batchReport(auditId, source = null) {
  const src = source || await auditSource(auditId);
  if (!src.audit) return null;

  const fromSnapshot = src.mode === SNAPSHOT;
  const params = [auditId];
  if (fromSnapshot) params.push(submissionIds(src));
  // $1 is sent on every branch, so each branch types it.
  const entrySql = src.mode === CLEARED
    ? `SELECT NULL::int AS id, NULL::int AS item_id, NULL::int AS batch_id, NULL::numeric AS qty,
              NULL::int AS bottles, NULL::int AS open_ml, NULL::int AS location_id,
              NULL::text AS location_text, NULL::int AS counted_by,
              NULL::timestamptz AS counted_at, NULL::text AS remarks
        WHERE $1::int IS NULL`
    : fromSnapshot
      ? `SELECT id, item_id, batch_id, qty, bottles, open_ml, location_id, location_text,
                counted_by, counted_at, remarks
           FROM submission_entries
          WHERE submission_id = ANY($2::int[]) AND $1::int IS NOT NULL`
      : `SELECT id, item_id, batch_id, qty, bottles, open_ml, location_id, location_text,
                counted_by, counted_at, remarks
           FROM count_entries
          WHERE audit_id = $1 AND status = 'active'`;

  const BATCH_INFO = `
    sc.name AS super_category, c.name AS brand,
    b.batch_no, b.is_active AS batch_active, b.origin AS batch_origin,
    b.created_in_audit, cb.name AS batch_created_by,
    COALESCE(NULLIF(btrim(CASE WHEN b.origin = 'counted' THEN NULL ELSE b.unit END), ''), i.unit) AS unit`;

  // Every individual entry — the detail sheet, and the location breakdown.
  const { rows: entries } = await query(
    `WITH e AS (${entrySql})
     SELECT e.id, e.item_id, i.name AS article, i.description, i.is_liquor,
            e.batch_id, ${BATCH_INFO},
            e.qty, e.bottles, e.open_ml,
            COALESCE(l.name, e.location_text) AS location,
            e.counted_by, u.name AS counted_by_name, e.counted_at, e.remarks
       FROM e
       JOIN items i ON i.id = e.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN item_batches b ON b.id = e.batch_id
       LEFT JOIN users cb ON cb.id = b.created_by
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = e.counted_by
      ORDER BY sc.sort_order NULLS LAST, sc.name NULLS LAST, c.name NULLS LAST, lower(i.name),
               (b.origin = 'counted') NULLS FIRST, lower(b.batch_no) NULLS FIRST, e.counted_at`,
    params
  );

  // One row per batch: every live batch of a live article, counted or not,
  // plus every (article, batch) that has entries, whatever its state.
  const { rows: keys } = await query(
    `WITH e AS (${entrySql}),
     keys AS (
       SELECT b.item_id, b.id AS batch_id FROM item_batches b
         JOIN items i ON i.id = b.item_id
        WHERE b.is_active AND i.is_active AND i.inventory_mode = 'warehouse'
       UNION
       SELECT DISTINCT item_id, batch_id FROM e
     )
     SELECT k.item_id, i.name AS article, i.description, i.is_liquor,
            k.batch_id, ${BATCH_INFO},
            -- A batch retired from the stock list has no book stock any more;
            -- its count still shows. The same rule R4 applies (live batches).
            CASE WHEN b.is_active THEN b.qty END AS stock_qty, b.expiry_date
       FROM keys k
       JOIN items i ON i.id = k.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN item_batches b ON b.id = k.batch_id
       LEFT JOIN users cb ON cb.id = b.created_by
      -- Super category → brand → material. Within a material: an entry with
      -- no batch first, then the stock list's batches, then — at the bottom —
      -- batches a counter created.
      ORDER BY sc.sort_order NULLS LAST, sc.name NULLS LAST, c.name NULLS LAST, lower(i.name),
               (b.origin = 'counted') NULLS FIRST,
               b.expiry_date NULLS LAST, lower(b.batch_no) NULLS FIRST`,
    params
  );

  const keyOf = (itemId, batchId) => `${itemId}:${batchId ?? '-'}`;
  const grouped = new Map();
  for (const e of entries) {
    const k = keyOf(e.item_id, e.batch_id);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(e);
  }

  const rows = keys.map((r) => {
    const list = grouped.get(keyOf(r.item_id, r.batch_id)) || [];
    const counted = list.length > 0;
    const sum = (f) => r3(list.reduce((t, e) => t + Number(e[f] || 0), 0));
    // Liquor compares sealed bottles with the book quantity; open ml is shown
    // on its own and never folded in.
    const physical = counted ? (r.is_liquor ? sum('bottles') : sum('qty')) : null;
    const openMl = counted && r.is_liquor ? sum('open_ml') : null;
    // A counted batch with no book stock (a NEW batch, or one the stock file
    // left blank) has stock 0: all it counted is excess. The Material-wise
    // Variance counts it that way, so the Physical Compile has to as well,
    // or the two Difference columns stop adding up to the same figure.
    const difference = counted ? r3(physical - Number(r.stock_qty ?? 0)) : null;
    // "Kitchen 5 · Store 3" — where the quantity was found.
    // Keyed case- and space-insensitively, so "Kitchen" and "kitchen " are
    // one place; the first spelling seen is the one shown.
    const byLoc = new Map();
    const shown = new Map();
    for (const e of list) {
      const v = Number(r.is_liquor ? e.bottles || 0 : e.qty || 0);
      const name = String(e.location || '—').replace(/\s+/g, ' ').trim() || '—';
      const k = name.toLowerCase();
      if (!shown.has(k)) shown.set(k, name);
      byLoc.set(k, r3((byLoc.get(k) || 0) + v));
    }
    for (const [k, q] of [...byLoc]) { byLoc.delete(k); byLoc.set(shown.get(k), q); }
    const { expiry_date: _drop, ...rest } = r;
    return {
      ...rest,
      is_new: r.batch_origin === 'counted',
      remarks: remarksFor(r),
      counted, entries: list.length,
      physical_qty: physical, counted_open_ml: openMl, difference,
      locations: [...byLoc].map(([name, qty]) => ({ name, qty })),
      status: !counted ? 'Not counted' : r.stock_qty == null ? 'No system qty'
        : difference === 0 ? 'Match' : difference > 0 ? 'Excess' : 'Short',
    };
  });

  const sourceLabel = src.mode === SNAPSHOT ? 'submitted' : src.mode === CLEARED ? 'cleared' : 'live';
  return { audit: src.audit, source: sourceLabel, rows, entries, totals: articleTotals(rows) };
}

// What the Remarks column says about a batch row.
function remarksFor(r) {
  if (r.batch_id == null) return 'Counted without a batch';
  if (r.batch_origin === 'counted') {
    return `NEW BATCH — created during counting${r.batch_created_by ? ` by ${r.batch_created_by}` : ''}`;
  }
  if (!r.batch_active) return 'Batch no longer on the stock list';
  return '';
}

// ── The article, merged ─────────────────────────────────────────────────────
// Every batch of an article added together: book stock across its batches
// against everything counted across them, new batches included. A batch with
// book stock that nobody counted adds to the system side and nothing to the
// physical side, so it shows up in the article's difference as the shortage
// it is.
//
// Units: a BLANK unit is "the material's unit", never a unit of its own — a
// stock file with no Unit column and a counter who typed one for a new batch
// are the same unit, and used to blank out the material's Stock. Only two
// different units actually written down (BOX and PCS) cannot be added; even
// then the book Stock still shows (when the stock batches share one unit) and
// the counts are listed per unit, so nothing goes missing — only the
// Difference is left out.
const unitKey = (u) => String(u || '').trim().toLowerCase();
function articleTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.item_id)) by.set(r.item_id, []);
    by.get(r.item_id).push(r);
  }
  const out = new Map();
  for (const [itemId, list] of by) {
    const named = new Map();          // unit key → first spelling seen
    for (const r of list) if (unitKey(r.unit) && !named.has(unitKey(r.unit))) named.set(unitKey(r.unit), String(r.unit).trim());
    const mixed = named.size > 1;
    const withStock = list.filter((r) => r.stock_qty != null);
    const counted = list.filter((r) => r.counted);
    const stockUnits = new Set(withStock.map((r) => unitKey(r.unit)).filter(Boolean));
    const system = withStock.length && stockUnits.size <= 1
      ? r3(withStock.reduce((t, r) => t + Number(r.stock_qty), 0)) : null;
    const physical = counted.length && !mixed
      ? r3(counted.reduce((t, r) => t + Number(r.physical_qty || 0), 0)) : null;
    // No book stock is stock 0 — the same rule as the batch lines, so both
    // sheets' Difference columns add up to the same figure.
    const physicalOrZero = physical ?? (!counted.length ? 0 : null);
    // "90 BOX + 5 PCS" — the counts of a mixed-unit material, per unit.
    const perUnit = new Map();
    for (const r of counted) {
      const k = unitKey(r.unit) || [...stockUnits][0] || '';
      perUnit.set(k, r3((perUnit.get(k) || 0) + Number(r.physical_qty || 0)));
    }
    const fallbackUnit = stockUnits.size === 1 ? named.get([...stockUnits][0]) : [...named.values()][0];
    out.set(itemId, {
      item_id: itemId, batches: list.length, mixed_units: mixed,
      unit: mixed ? (fallbackUnit || '') : ([...named.values()][0] || ''),
      units: [...named.values()],
      new_batches: list.filter((r) => r.is_new).length,
      system_qty: system, physical_qty: physical,
      physical_by_unit: mixed
        ? [...perUnit].map(([k, q]) => `${q}${named.get(k) ? ` ${named.get(k)}` : ''}`).join(' + ')
        : null,
      difference: !mixed && physicalOrZero != null && (system != null || counted.length)
        ? r3(physicalOrZero - (system ?? 0)) : null,
    });
  }
  return out;
}

// ── Spreadsheet layout ──────────────────────────────────────────────────────

const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
const cell = (v) => (v == null ? null : v);

export const SUMMARY_HEADERS = ['Material', 'Material Description', 'Batch', 'Unit',
  'System Qty', 'Physical Qty', 'Open ML', 'Difference', 'Location', 'Counted By', 'Status', 'Remarks'];

// One spreadsheet line from a location line.
export function summaryRow(l) {
  return [l.material, l.description, l.batch, l.unit,
    cell(l.stock), cell(l.physical), cell(l.open_ml), cell(l.difference),
    l.location, l.counted_by, l.status, l.remarks];
}

// "units differ (BOX / PCS) — counted 90 BOX + 5 PCS, no difference worked out"
function mixedNote(t) {
  return `units differ (${t.units.join(' / ')})${t.physical_by_unit ? ` — counted ${t.physical_by_unit}` : ''}, no difference worked out`;
}

// The line under an article's batches: the article as a whole.
export function totalRow(r, t) {
  const remarks = [
    `${t.batches} batches merged`,
    t.new_batches ? `incl. ${t.new_batches} NEW BATCH${t.new_batches === 1 ? '' : 'ES'}` : null,
    t.mixed_units ? mixedNote(t) : null,
  ].filter(Boolean).join(' · ');
  return [`${r.article} — TOTAL`, r.description || '', '', t.unit,
    cell(t.system_qty), cell(t.physical_qty), null,
    cell(t.difference), '', '',
    t.mixed_units || t.difference == null ? '' : t.difference === 0 ? 'Match' : t.difference > 0 ? 'Excess' : 'Short',
    remarks];
}

// Location lines, with each multi-batch material's TOTAL line after them.
export function summaryLines(report) {
  const lines = locationLines(report, { includeUncounted: true });
  const out = [];
  lines.forEach((l, i) => {
    out.push(summaryRow(l));
    const next = lines[i + 1];
    const t = report.totals.get(l.item_id);
    if ((!next || next.item_id !== l.item_id) && t && t.batches > 1) {
      out.push(totalRow({ article: l.material, description: l.description }, t));
    }
  });
  return out;
}

export const ENTRY_HEADERS = ['Material', 'Material Description', 'Batch', 'Quantity',
  'Open ML', 'Location', 'Unit', 'Counted By', 'Counted At (UTC)', 'Remarks'];

export function entryRow(e) {
  const flag = e.batch_id == null ? 'No batch' : e.batch_origin === 'counted' ? 'NEW BATCH' : '';
  return [e.article, e.description || '', e.batch_no || '(no batch)',
    cell(e.is_liquor ? e.bottles : e.qty), e.is_liquor ? cell(e.open_ml) : null,
    e.location || '', e.unit, e.counted_by_name || '', when(e.counted_at),
    [flag, e.remarks].filter(Boolean).join(' · ')];
}

// The two sheets every warehouse workbook carries: one line per batch, and
// one line per entry. Title and provenance on top so a printed sheet still
// says which audit, and which set of numbers, it shows.
export function batchSheets(report) {
  const a = report.audit;
  const title = `${a.store_name} — ${a.audit_date instanceof Date
    ? a.audit_date.toISOString().slice(0, 10) : String(a.audit_date).slice(0, 10)}`;
  const provenance = report.source === 'submitted' ? 'Submitted count'
    : report.source === 'cleared' ? 'Submission cleared — nothing to report'
      : 'Live count — PROVISIONAL, not yet submitted';
  const newBatches = report.rows.filter((r) => r.is_new).length;
  return [
    { name: 'Batch Summary', aoa: [
      [`Batch-wise stock count · ${title}`],
      [`${provenance} · one line per batch and location · ${newBatches} batch(es) created during counting`],
      [],
      SUMMARY_HEADERS,
      ...summaryLines(report),
    ] },
    { name: 'Batch Entries', aoa: [
      [`Batch-wise entries · ${title}`],
      [`${provenance} · ${report.entries.length} entries`],
      [],
      ENTRY_HEADERS,
      ...report.entries.map(entryRow),
    ] },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// The two warehouse reports.
//
// PHYSICAL COMPILE SHEET — exactly what the auditors entered, every auditor
// combined, LOCATION-WISE: one line per material + batch + location (two
// auditors counting the same batch in the same place are added together).
// Nothing is added that nobody entered — a batch nobody counted is not a line
// here; its shortage is on the material-wise variance.
//
// A batch counted in several places has several lines. Its Stock and
// Difference sit on its FIRST line only, so adding the columns never counts a
// batch's book stock twice.
//
// MATERIAL-WISE VARIANCE — batches merged: one line per material, book stock
// of all its batches against everything counted across them.
// ═══════════════════════════════════════════════════════════════════════════
export const COMPILE_HEADERS = ['Super category', 'Brand', 'Material', 'Material Description',
  'Batch', 'Stock', 'Physical Qty', 'Difference', 'Locations', 'Counted By', 'Remarks'];

// ── One line per batch + location ───────────────────────────────────────────
// A batch found in three places is THREE lines, never one line reading
// "G2 · F2 · C3". Lines follow the batch order of the report (super category →
// brand → material → batches, new ones last). Within a batch, places keep the
// order they were first counted in. Each AUDITOR's count is its own line,
// named in Counted By — two auditors at the same batch and place are two
// lines; one auditor's several entries there ("Kitchen", "kitchen ") are one.
//
// The batch's Stock, Difference and Status sit on its FIRST line only, so
// adding a column never counts a batch's book stock twice.
//
// includeUncounted: a batch with no count at all still gets one line —
// Physical blank, Difference = −Stock, "Not counted" — for the screens that
// list every batch. The compile sheet leaves it out: it is what was entered.
export function locationLines(report, { includeUncounted = false } = {}) {
  const byBatch = new Map();
  for (const e of report.entries) {
    const k = `${e.item_id}:${e.batch_id ?? '-'}`;
    const loc = String(e.location || '—').replace(/\s+/g, ' ').trim() || '—';
    if (!byBatch.has(k)) byBatch.set(k, new Map());
    const places = byBatch.get(k);
    const lk = `${loc.toLowerCase()}\u0000${e.counted_by ?? ''}`;
    if (!places.has(lk)) places.set(lk, { location: loc, qty: 0, open_ml: 0, e, by: e.counted_by_name || '' });
    const p = places.get(lk);
    p.qty = r3(p.qty + Number((e.is_liquor ? e.bottles : e.qty) || 0));
    p.open_ml = r3(p.open_ml + Number(e.open_ml || 0));
  }
  const out = [];
  for (const b of report.rows) {
    const k = `${b.item_id}:${b.batch_id ?? '-'}`;
    const places = [...(byBatch.get(k)?.values() || [])];
    const base = {
      item_id: b.item_id, batch_id: b.batch_id, is_new: b.is_new, is_liquor: b.is_liquor,
      super_category: b.super_category || '', brand: b.brand || '',
      material: b.article, description: b.description || '',
      batch: b.batch_no || '(no batch)', unit: b.unit || '',
    };
    if (!places.length) {
      if (!includeUncounted) continue;
      out.push({
        ...base, first_of_batch: true, counted: false,
        stock: b.stock_qty, physical: null, open_ml: null,
        difference: b.stock_qty != null ? r3(-Number(b.stock_qty)) : null,
        location: '', counted_by: '', status: b.status,
        remarks: [b.remarks, b.stock_qty != null ? 'Not counted' : null].filter(Boolean).join(' · '),
      });
      continue;
    }
    places.forEach((p, i) => {
      const first = i === 0;
      const notes = [
        first ? b.remarks : (b.is_new ? 'NEW BATCH' : null),
        first && places.length > 1 ? `batch total ${b.physical_qty} across ${places.length} lines` : null,
        first && b.stock_qty == null && b.batch_id != null && !b.is_new && b.batch_active ? 'No system stock' : null,
        b.is_liquor && p.open_ml ? `+ ${p.open_ml} ml open` : null,
      ].filter(Boolean);
      out.push({
        ...base, first_of_batch: first, counted: true,
        stock: first ? b.stock_qty : null, physical: p.qty,
        open_ml: b.is_liquor ? p.open_ml : null,
        difference: first ? b.difference : null,
        location: p.location, counted_by: p.by, status: first ? b.status : '',
        remarks: notes.join(' · '),
      });
    });
  }
  return out;
}

// PHYSICAL COMPILE SHEET — exactly what was entered, line by line, plus one
// line for every stock batch nobody counted (Physical blank, "Not counted").
// Without those lines its Stock column held only the counted batches' stock
// and never matched the Material-wise Variance, which has every batch.
export function compileRows(report) {
  return locationLines(report, { includeUncounted: true }).map((l) => ({ ...l, locations: l.location }));
}

export const MATERIAL_HEADERS = ['Super category', 'Brand', 'Material', 'Material Description',
  'Stock', 'Physical Qty', 'Difference', 'Locations', 'Remarks'];

// Why a counted material has no Stock figure — said plainly, so a blank is
// never a mystery: its batches were taken off the stock list by a later
// import, the stock file left Stock blank, or it simply is not in the file.
function noStockReason(report, itemId) {
  const rows = report.rows.filter((r) => r.item_id === itemId);
  const stockRows = rows.filter((r) => r.batch_id != null && !r.is_new);
  if (stockRows.some((r) => r.stock_qty != null)) return 'Stock batches in different units — not totalled';
  if (stockRows.some((r) => r.batch_active === false)) return 'No system stock — counted batch is no longer on the stock list (removed by a later stock import)';
  if (stockRows.some((r) => r.batch_active)) return 'No system stock — Stock is blank for this material in the stock file';
  return 'No system stock — material has no batch in the stock file';
}

export function materialRows(report) {
  const out = [];
  const seen = new Map();
  for (const r of report.rows) {
    if (!seen.has(r.item_id)) {
      seen.set(r.item_id, { first: r, locs: new Map(), counted: false });
      out.push(r.item_id);
    }
    const m = seen.get(r.item_id);
    if (r.counted) m.counted = true;
    for (const l of r.locations) {
      const k = l.name.toLowerCase();
      const cur = m.locs.get(k) || { name: l.name, qty: 0 };
      cur.qty = r3(cur.qty + l.qty);
      m.locs.set(k, cur);
    }
  }
  return out.map((id) => {
    const { first: r, locs, counted } = seen.get(id);
    const t = report.totals.get(id);
    const notes = [
      t.batches > 1 ? `${t.batches} batches` : null,
      t.new_batches ? `incl. ${t.new_batches} NEW BATCH${t.new_batches === 1 ? '' : 'ES'}` : null,
      !counted ? 'Not counted' : null,
      counted && t.system_qty == null ? noStockReason(report, id) : null,
      t.mixed_units ? mixedNote(t) : null,
    ].filter(Boolean);
    return {
      item_id: id, super_category: r.super_category || '', brand: r.brand || '',
      material: r.article, description: r.description || '', unit: t.unit || '',
      stock: t.system_qty,
      physical: t.physical_qty,
      difference: t.difference,
      locations: [...locs.values()].map((l) => `${l.name} ${l.qty}`).join(' · '),
      remarks: notes.join(' · '),
    };
  });
}

const titleOf = (report) => {
  const a = report.audit;
  const d = a.audit_date instanceof Date ? a.audit_date.toISOString().slice(0, 10) : String(a.audit_date).slice(0, 10);
  const src = report.source === 'submitted' ? 'Submitted count — all auditors combined'
    : report.source === 'cleared' ? 'Submission cleared — nothing to report'
      : 'Live count — PROVISIONAL, not yet submitted';
  return { line1: `${a.store_name} — ${d}`, src };
};

export function compileSheet(report) {
  const rows = compileRows(report);
  const { line1, src } = titleOf(report);
  return { name: 'Physical Compile Sheet', aoa: [
    [`Physical Compile Sheet · ${line1}`],
    [`${src} · location-wise, as entered · ${rows.length} lines · Stock and Difference on each batch's first line · batches not counted are listed with Physical blank`],
    [],
    COMPILE_HEADERS,
    ...rows.map((r) => [r.super_category, r.brand, r.material, r.description, r.batch,
      cell(r.stock), cell(r.physical), cell(r.difference), r.locations, r.counted_by, r.remarks]),
  ] };
}

export function materialSheet(report) {
  const rows = materialRows(report);
  const { line1, src } = titleOf(report);
  return { name: 'Material-wise Variance', aoa: [
    [`Material-wise Variance · ${line1}`],
    [`${src} · ${rows.length} materials · batches merged`],
    [],
    MATERIAL_HEADERS,
    ...rows.map((r) => [r.super_category, r.brand, r.material, r.description,
      cell(r.stock), cell(r.physical), cell(r.difference), r.locations, r.remarks]),
  ] };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALL ENTRIES — every entry every auditor made in this audit, ACTIVE AND
// VOID, straight from the working record. This is the list to reconcile
// against each auditor's own figures line by line: nothing merged, nothing
// filtered, every void with who withdrew it, when and why.
// ═══════════════════════════════════════════════════════════════════════════
export const ALL_ENTRY_HEADERS = ['Entry ID', 'Super category', 'Brand', 'Material', 'Material Description',
  'Batch', 'Quantity', 'Open ML', 'Unit', 'Location', 'Counted By', 'Counted At (UTC)',
  'Status', 'Void Reason', 'Voided By', 'Voided At (UTC)', 'Remarks'];

export async function allEntries(auditId) {
  const { rows } = await query(
    `SELECT ce.id, sc.name AS super_category, c.name AS brand, i.name AS material,
            i.description, i.is_liquor, b.batch_no, b.origin AS batch_origin,
            COALESCE(NULLIF(btrim(CASE WHEN b.origin = 'counted' THEN NULL ELSE b.unit END), ''), i.unit) AS unit,
            ce.qty, ce.bottles, ce.open_ml,
            COALESCE(l.name, ce.location_text) AS location,
            u.name AS counted_by, ce.counted_at, ce.status, ce.void_reason,
            vu.name AS voided_by, ce.voided_at, ce.remarks
       FROM count_entries ce
       JOIN items i ON i.id = ce.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN item_batches b ON b.id = ce.batch_id
       LEFT JOIN locations l ON l.id = ce.location_id
       LEFT JOIN users u ON u.id = ce.counted_by
       LEFT JOIN users vu ON vu.id = ce.voided_by
      WHERE ce.audit_id = $1
      ORDER BY u.name NULLS LAST, ce.counted_at, ce.id`,
    [auditId]
  );
  return rows.map((r) => ({
    id: r.id, super_category: r.super_category || '', brand: r.brand || '',
    material: r.material, description: r.description || '',
    batch: r.batch_no || '(no batch)', is_new: r.batch_origin === 'counted',
    quantity: r.is_liquor ? r.bottles : r.qty, open_ml: r.is_liquor ? r.open_ml : null,
    unit: r.unit || '', location: r.location || '',
    counted_by: r.counted_by || '', counted_at: r.counted_at,
    status: r.status === 'void' ? 'VOID' : 'Active',
    void_reason: r.void_reason || '', voided_by: r.voided_by || '', voided_at: r.voided_at,
    remarks: [r.batch_origin === 'counted' ? 'NEW BATCH' : null, r.remarks].filter(Boolean).join(' · '),
  }));
}

export function allEntriesSheet(audit, rows) {
  const d = audit.audit_date instanceof Date ? audit.audit_date.toISOString().slice(0, 10) : String(audit.audit_date).slice(0, 10);
  const voids = rows.filter((r) => r.status === 'VOID').length;
  return { name: 'All Entries', aoa: [
    [`All Entries (active and void) · ${audit.store_name} — ${d}`],
    [`${rows.length} entries · ${rows.length - voids} active · ${voids} void · every auditor, live`],
    [],
    ALL_ENTRY_HEADERS,
    ...rows.map((r) => [r.id, r.super_category, r.brand, r.material, r.description, r.batch,
      cell(r.quantity), cell(r.open_ml), r.unit, r.location, r.counted_by, when(r.counted_at),
      r.status, r.void_reason, r.voided_by, when(r.voided_at), r.remarks]),
  ] };
}
