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
    b.batch_no, b.is_active AS batch_active, b.origin AS batch_origin,
    b.created_in_audit, cb.name AS batch_created_by,
    COALESCE(NULLIF(btrim(b.unit), ''), i.unit) AS unit`;

  // Every individual entry — the detail sheet, and the location breakdown.
  const { rows: entries } = await query(
    `WITH e AS (${entrySql})
     SELECT e.id, e.item_id, i.name AS article, i.description, i.is_liquor,
            e.batch_id, ${BATCH_INFO},
            e.qty, e.bottles, e.open_ml,
            COALESCE(l.name, e.location_text) AS location,
            u.name AS counted_by_name, e.counted_at, e.remarks
       FROM e
       JOIN items i ON i.id = e.item_id
       LEFT JOIN item_batches b ON b.id = e.batch_id
       LEFT JOIN users cb ON cb.id = b.created_by
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = e.counted_by
      ORDER BY lower(i.name), (b.origin = 'counted') NULLS FIRST, lower(b.batch_no) NULLS FIRST,
               e.counted_at`,
    params
  );

  // One row per batch: every live batch of a live article, counted or not,
  // plus every (article, batch) that has entries, whatever its state.
  const { rows: keys } = await query(
    `WITH e AS (${entrySql}),
     keys AS (
       SELECT b.item_id, b.id AS batch_id FROM item_batches b
         JOIN items i ON i.id = b.item_id
        WHERE b.is_active AND i.is_active
       UNION
       SELECT DISTINCT item_id, batch_id FROM e
     )
     SELECT k.item_id, i.name AS article, i.description, i.is_liquor,
            k.batch_id, ${BATCH_INFO},
            b.qty AS stock_qty, b.expiry_date
       FROM keys k
       JOIN items i ON i.id = k.item_id
       LEFT JOIN item_batches b ON b.id = k.batch_id
       LEFT JOIN users cb ON cb.id = b.created_by
      -- Within an article: an entry with no batch first, then the stock
      -- list's batches, then — at the bottom — batches a counter created.
      ORDER BY lower(i.name), (b.origin = 'counted') NULLS FIRST,
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
    const difference = counted && r.stock_qty != null ? r3(physical - Number(r.stock_qty)) : null;
    // "Kitchen 5 · Store 3" — where the quantity was found.
    const byLoc = new Map();
    for (const e of list) {
      const v = Number(r.is_liquor ? e.bottles || 0 : e.qty || 0);
      byLoc.set(e.location || '—', r3((byLoc.get(e.location || '—') || 0) + v));
    }
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
// it is. Batches held in different units cannot be added into one number, so
// such an article is marked rather than totalled.
function articleTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.item_id)) by.set(r.item_id, []);
    by.get(r.item_id).push(r);
  }
  const out = new Map();
  for (const [itemId, list] of by) {
    const units = new Set(list.map((r) => String(r.unit || '').trim().toLowerCase()));
    const withStock = list.filter((r) => r.stock_qty != null);
    const counted = list.filter((r) => r.counted);
    const system = withStock.length ? r3(withStock.reduce((t, r) => t + Number(r.stock_qty), 0)) : null;
    const physical = counted.length ? r3(counted.reduce((t, r) => t + Number(r.physical_qty || 0), 0)) : null;
    const physicalOrZero = physical ?? (system != null ? 0 : null);
    out.set(itemId, {
      item_id: itemId, batches: list.length, mixed_units: units.size > 1,
      unit: list[0].unit, new_batches: list.filter((r) => r.is_new).length,
      system_qty: system, physical_qty: physical,
      difference: system != null && physicalOrZero != null ? r3(physicalOrZero - system) : null,
    });
  }
  return out;
}

// ── Spreadsheet layout ──────────────────────────────────────────────────────

const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
const cell = (v) => (v == null ? null : v);

export const SUMMARY_HEADERS = ['Material', 'Material Description', 'Batch', 'Unit',
  'System Qty', 'Physical Qty', 'Open ML', 'Difference', 'Locations', 'Status', 'Remarks'];

export function summaryRow(r) {
  return [r.article, r.description || '', r.batch_no || '(no batch)', r.unit,
    cell(r.stock_qty), cell(r.physical_qty), cell(r.counted_open_ml), cell(r.difference),
    r.locations.map((l) => `${l.name} ${l.qty}`).join(' · '), r.status, r.remarks];
}

// The line under an article's batches: the article as a whole.
export function totalRow(r, t) {
  const remarks = [
    `${t.batches} batches merged`,
    t.new_batches ? `incl. ${t.new_batches} NEW BATCH${t.new_batches === 1 ? '' : 'ES'}` : null,
    t.mixed_units ? 'batches in different units — not totalled' : null,
  ].filter(Boolean).join(' · ');
  return [`${r.article} — TOTAL`, r.description || '', '', t.mixed_units ? 'mixed' : t.unit,
    t.mixed_units ? null : cell(t.system_qty), t.mixed_units ? null : cell(t.physical_qty), null,
    t.mixed_units ? null : cell(t.difference), '',
    t.mixed_units || t.difference == null ? '' : t.difference === 0 ? 'Match' : t.difference > 0 ? 'Excess' : 'Short',
    remarks];
}

// Batch rows with each multi-batch article's total line after its batches.
export function summaryLines(report) {
  const out = [];
  report.rows.forEach((r, i) => {
    out.push(summaryRow(r));
    const next = report.rows[i + 1];
    const t = report.totals.get(r.item_id);
    if ((!next || next.item_id !== r.item_id) && t && t.batches > 1) out.push(totalRow(r, t));
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
      [`${provenance} · ${report.rows.length} batch rows · ${newBatches} created during counting`],
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
