import { query } from '../db.js';
import { measurementBasis, finalTotals, BASES } from './measure.js';
import { auditSource, submissionIds, SNAPSHOT, CLEARED } from './submissions.js';
import { reportLocations } from './locations.js';

export const LIQUOR_ESTIMATION_NOTE =
  'Open bottle quantities are recorded by visual estimation.';

// ── Tolerance bands from settings (NOT hardcoded) ────────────────────────────
export async function getTolerances() {
  const { rows } = await query('SELECT key, value FROM settings');
  const m = Object.fromEntries(rows.map((r) => [r.key, parseFloat(r.value)]));
  return {
    liquor: { ok: m.tolerance_liquor_ok ?? 2, warn: m.tolerance_liquor_warn ?? 4 },
    general: { ok: m.tolerance_general_ok ?? 1, warn: m.tolerance_general_warn ?? 3 },
  };
}

// status band from a signed variance % and item type
export function bandFor(pct, isLiquor, tol) {
  const t = isLiquor ? tol.liquor : tol.general;
  const abs = Math.abs(pct);
  if (abs <= t.ok) return 'OK';
  if (abs <= t.warn) return 'Warning';
  return 'Critical';
}

// ── Core per-item aggregates for one audit ───────────────────────────────────
// Liquor bottles and open ml are kept SEPARATE throughout and never combined.
//
// THE ONE PLACE physical quantity is read. Every report is built on this, so
// switching the source here — the auditor's live entries while the count is in
// progress, the submitted snapshot once it has been sent — moves all six
// reports at once and none of them can disagree about which numbers they show.
export async function auditItemAggregates(auditId, source = null) {
  const src = source || await auditSource(auditId);
  // Reading from submission_entries and reading from count_entries differ in
  // exactly one clause. Everything downstream — zone split, native quantity,
  // photo coverage — is identical, so the two stay impossible to drift apart.
  const fromSnapshot = src.mode === SNAPSHOT;
  // With a snapshot the source is EVERY standing submission, not one. That is
  // how the auditors are combined: two auditors' quantities for the same item
  // and location land in the same location column and are summed, with no
  // merge step and nothing for the admin to click.
  const entrySource = fromSnapshot
    ? `SELECT e.qty, e.bottles, e.open_ml, e.photo_url, e.location_id
         FROM submission_entries e
        WHERE e.item_id = i.id AND e.submission_id = ANY($2::int[])`
    : `SELECT e.qty, e.bottles, e.open_ml, e.photo_url, e.location_id
         FROM count_entries e
        WHERE e.item_id = i.id AND e.audit_id = $1 AND e.status = 'active'`;
  // A cleared submission has nothing to read. Routes stop before they get
  // here; this makes the fallback empty rather than wrong.
  const noRows = src.mode === CLEARED;
  // The report's columns. Read from the locations table, never hardcoded, so
  // renaming a place or adding a sixth changes the report with no code change.
  const locations = await reportLocations(auditId, fromSnapshot ? submissionIds(src) : null);
  const params = [auditId];
  if (fromSnapshot) params.push(submissionIds(src));

  const { rows } = await query(
    `SELECT i.id, i.name, i.unit, i.is_liquor, i.bottle_size_ml, i.bottle_unit_size, i.rate,
            i.super_category_id, i.category_id,
            sc.name AS super_category_name, c.name AS category_name,
            COALESCE(agg.total_qty, 0)      AS total_qty,
            COALESCE(agg.total_bottles, 0)  AS total_bottles,
            COALESCE(agg.total_open_ml, 0)  AS total_open_ml,
            -- Physical quantity broken down by LOCATION — one figure per
            -- place the item was counted, keyed by location id. The report
            -- turns this into one column per location.
            COALESCE(locagg.by_location, '{}'::jsonb) AS by_location,
            COALESCE(agg.entry_count, 0)::int AS entry_count,
            COALESCE(agg.active_zero, 0)::int AS active_zero,
            COALESCE(agg.with_photo, 0)::int  AS with_photo,
            ss.qty AS system_qty, ss.bottles AS system_bottles, ss.open_ml AS system_open_ml,
            (ss.item_id IS NOT NULL) AS has_system,
            (na.id IS NOT NULL) AS not_applicable
       FROM items i
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN LATERAL (
         SELECT SUM(native) AS total_qty, SUM(bottles) AS total_bottles,
                SUM(open_ml) AS total_open_ml, COUNT(*) AS entry_count,
                COUNT(*) FILTER (WHERE COALESCE(qty,0)=0 AND COALESCE(bottles,0)=0 AND COALESCE(open_ml,0)=0) AS active_zero,
                COUNT(*) FILTER (WHERE photo_url IS NOT NULL) AS with_photo
           FROM (
             SELECT src.qty, src.bottles, src.open_ml, src.photo_url,
                    -- Liquor counts in sealed bottles; everything else in its
                    -- own unit. Open ml is NEVER folded in here.
                    COALESCE(CASE WHEN i.is_liquor THEN src.bottles ELSE src.qty END, 0) AS native
               FROM ( ${entrySource} ) src
              WHERE ${noRows ? 'FALSE' : 'TRUE'}
           ) e
       ) agg ON TRUE
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(t.lid::text, t.q) AS by_location
           FROM (
             SELECT src.location_id AS lid,
                    SUM(COALESCE(CASE WHEN i.is_liquor THEN src.bottles ELSE src.qty END, 0)) AS q
               FROM ( ${entrySource} ) src
              WHERE src.location_id IS NOT NULL AND ${noRows ? 'FALSE' : 'TRUE'}
              GROUP BY src.location_id
           ) t
       ) locagg ON TRUE
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
       LEFT JOIN audit_na na ON na.item_id = i.id AND na.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
    params
  );
  return rows.map((r) => {
    const physicalQty = r.is_liquor ? Number(r.total_bottles) : Number(r.total_qty);
    const value = r.rate != null ? physicalQty * Number(r.rate) : null;
    // One number per location column, in column order, zero-filled. The
    // location columns must always add up to the physical total — that is the
    // reconciliation a reader checks first — so the total is the SUM of these,
    // not a separately aggregated figure that could drift from them.
    const by = r.by_location || {};
    const byLocation = locations.map((l) => Number(by[String(l.id)] || 0));
    return {
      ...r,
      physical_qty: physicalQty,
      by_location: byLocation,
      location_total: Number(byLocation.reduce((a, b) => a + b, 0).toFixed(3)),
      bottle_unit_size: Number(r.bottle_unit_size ?? 1),
      value,
      counted: r.entry_count > 0,
    };
  });
}

// The columns for one audit, so a caller can label what auditItemAggregates
// returned without querying again.
export async function auditLocations(auditId, source = null) {
  const src = source || await auditSource(auditId);
  return reportLocations(auditId, src.mode === SNAPSHOT ? submissionIds(src) : null);
}

export async function getAudit(auditId) {
  const { rows } = await query(
    `SELECT a.*, s.name AS store_name, s.code AS store_code
       FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id = $1`,
    [auditId]
  );
  return rows[0] || null;
}

// Counted / uncounted progress, used to mark variance provisional.
export async function auditProgress(auditId) {
  const items = await auditItemAggregates(auditId);
  const total = items.length;
  const counted = items.filter((i) => i.counted || i.not_applicable).length;
  return { total, counted, uncounted: total - counted };
}

// ── The standard row, shared by R1 / R2 / R3 / R4 ───────────────────────────
// Every report shows the same columns for the same item. This builds them once
// from auditItemAggregates, so a figure cannot be computed one way in R2 and
// another way in R4 — which is exactly how they drifted apart before.
export function standardRow(i) {
  const measures = finalTotals({
    total: i.location_total,
    size: i.bottle_unit_size,
    looseMl: i.total_open_ml,
  });
  return {
    item_id: i.id,
    name: i.name,
    unit: i.unit,
    is_liquor: i.is_liquor,
    super_category: i.super_category_name || '—',
    category: i.category_name || '—',
    super_category_id: i.super_category_id,
    category_id: i.category_id,
    bottle_unit_size: Number(i.bottle_unit_size ?? 1),
    by_location: i.by_location,
    ...measures,
    // What Final Total Qty is expressed in.
    remarks: measurementBasis(i.unit),
    physical_qty: i.physical_qty,
    // Liquor keeps sealed bottles and open ml SEPARATE — never combined.
    total_bottles: i.is_liquor ? Number(i.total_bottles) : null,
    total_open_ml: Number(i.total_open_ml || 0),
    rate: i.rate == null ? null : Number(i.rate),
    entry_count: i.entry_count,
    counted: i.counted,
    not_applicable: !!i.not_applicable,
  };
}

// Every item on this audit, as standard rows, with the report's columns.
// `loc` is the store code, part of the standard format.
export async function standardRows(auditId, source = null) {
  const src = source || await auditSource(auditId);
  const [items, locations, audit] = await Promise.all([
    auditItemAggregates(auditId, src),
    auditLocations(auditId, src),
    getAudit(auditId),
  ]);
  const loc = audit?.store_code || '';
  const rows = items.map((i) => ({ ...standardRow(i), loc }));
  rows.forEach((r, n) => { r.s_no = n + 1; });
  return { rows, locations, audit, source: src };
}

// ── R1 Physical Stock Summary ───────────────────────────────────────────────
// Grouped by super category, then category, with a subtotal per category, a
// subtotal per super category, and a grand total.
export async function physicalSummary(auditId) {
  const { rows, locations, audit } = await standardRows(auditId);
  // Only what was actually counted. An item nobody counted has nothing to
  // summarise, and listing hundreds of zero rows buries the real figures.
  const counted = rows.filter((r) => r.entry_count > 0 || r.not_applicable);

  const bucket = (extra) => ({
    ...extra, items: 0,
    by_location: new Array(locations.length).fill(0),
    location_total: 0, loose_ml: 0, final_total_qty: 0, value: 0,
  });
  const add = (b, r) => {
    b.items += 1;
    (r.by_location || []).forEach((v, k) => { b.by_location[k] += Number(v || 0); });
    b.location_total += Number(r.location_total || 0);
    b.loose_ml += Number(r.loose_ml || 0);
    b.final_total_qty += Number(r.final_total_qty || 0);
    // Value follows the same rule as R4: Final Total Qty × Rate, and an item
    // with no rate contributes nothing rather than being counted as zero.
    if (r.rate != null) b.value += Number(r.final_total_qty || 0) * r.rate;
  };
  const finish = (b) => ({
    ...b,
    by_location: b.by_location.map(round3),
    location_total: round3(b.location_total),
    loose_ml: round3(b.loose_ml),
    final_total_qty: round3(b.final_total_qty),
    value: round2(b.value),
  });

  const bySuper = new Map();
  for (const r of counted) {
    const sKey = r.super_category;
    const cKey = r.category;
    if (!bySuper.has(sKey)) {
      bySuper.set(sKey, { ...bucket({ super_category: sKey }), categories: new Map() });
    }
    const sg = bySuper.get(sKey);
    if (!sg.categories.has(cKey)) {
      sg.categories.set(cKey, bucket({ super_category: sKey, category: cKey }));
    }
    add(sg, r);
    add(sg.categories.get(cKey), r);
  }

  const groups = [...bySuper.values()].map((sg) => ({
    ...finish(sg),
    categories: [...sg.categories.values()].map(finish),
  }));

  const grandBucket = bucket({});
  for (const r of counted) add(grandBucket, r);
  const grand = finish(grandBucket);

  return {
    audit, locations, groups, grand,
    // Flat category list retained for callers that want a single table.
    categories: groups.flatMap((g) => g.categories),
  };
}

// ── R2 Item Detail — REPORT view: TOTALS ONLY ───────────────────────────────
// One line per item carrying its total. No per-entry lines and no redundant
// "<item> Total" row. Section and category are included (the join that was
// missing). The per-entry breakdown still exists in the database and on the
// admin count screen — it simply never appears in a client report.
export async function itemDetailTotals(auditId) {
  const { rows, locations, audit } = await standardRows(auditId);
  // TOTALS ONLY — one line per item. The per-entry breakdown lives on the
  // admin count screen and never appears in a report given to the client.
  return {
    audit, locations,
    rows: rows.filter((r) => r.entry_count > 0 || r.not_applicable),
  };
}

// ── Admin-only working view: every individual entry, including voided ────────
// Used by the admin count screen to verify how a total was arrived at.
export async function itemEntriesForAdmin(auditId, itemId = null) {
  const params = [auditId];
  let itemFilter = '';
  if (itemId) { params.push(itemId); itemFilter = `AND ce.item_id = $${params.length}`; }
  const { rows } = await query(
    `SELECT ce.id, ce.item_id, i.name, i.unit, i.is_liquor,
            ce.qty, ce.bottles, ce.open_ml, ce.location_text, ce.remarks, ce.photo_url,
            ce.status, ce.void_reason, ce.counted_at,
            -- WHO counted it. With per-auditor sheets this is no longer a
            -- detail: it is how the admin tells two auditors' rows apart.
            ce.counted_by, u.name AS counted_by_name, u.username AS counted_by_username
       FROM count_entries ce
       JOIN items i ON i.id = ce.item_id
       JOIN users u ON u.id = ce.counted_by
      WHERE ce.audit_id = $1 ${itemFilter}
      ORDER BY i.name, ce.counted_at`,
    params
  );
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.item_id) || {
      item_id: r.item_id, name: r.name, unit: r.unit, is_liquor: r.is_liquor,
      entries: [], total_qty: 0, total_bottles: 0, total_open_ml: 0,
    };
    g.entries.push(r);
    if (r.status === 'active') {
      g.total_qty += Number(r.qty || 0);
      g.total_bottles += Number(r.bottles || 0);
      g.total_open_ml += Number(r.open_ml || 0);
    }
    map.set(r.item_id, g);
  }
  return [...map.values()];
}

// R3 — liquor report, bottles and ml separate
export async function liquorReport(auditId) {
  const { rows, locations, audit } = await standardRows(auditId);
  // Sealed bottles and open ml stay SEPARATE and are never combined. The
  // location columns count sealed bottles; open ml rides in its own column,
  // exactly as it does on every other report.
  return {
    audit, locations,
    rows: rows.filter((r) => r.is_liquor),
    footnote: LIQUOR_ESTIMATION_NOTE,
  };
}

// Groups variance rows by super category, then category, with subtotals at
// both levels. Used by the on-screen report and by the Excel/PDF exports so
// they always present the same structure.
// A subtotal bucket carries every figure the row level carries, so a category
// subtotal, a super-category subtotal and the grand total are all comparable.
//
// Rupee figures are summed ONLY over items that actually have a rate. An item
// with no rate contributes nothing rather than a false zero, and `no_rate`
// records how many were left out so the shortfall is always visible.
// Subtotals carry the SAME location columns as the rows above them, so a
// column reads straight down from an item to the grand total. The width comes
// from the location list, so adding a location widens the subtotals too.
function emptyBucket(extra, locationCount = 0) {
  return {
    ...extra, items: 0, no_rate: 0,
    physical_qty: 0, system_qty: 0, variance: 0,
    physical_value: 0, system_value: 0, variance_value: 0,
    by_location: new Array(locationCount).fill(0),
    location_total: 0, loose_ml: 0, final_total_qty: 0,
  };
}

function addToBucket(bucket, r) {
  bucket.items += 1;
  bucket.physical_qty += Number(r.physical_qty || 0);
  bucket.system_qty += Number(r.system_qty || 0);
  bucket.variance += Number(r.variance || 0);
  (r.by_location || []).forEach((v, i) => { bucket.by_location[i] = (bucket.by_location[i] || 0) + Number(v || 0); });
  bucket.location_total += Number(r.location_total || 0);
  bucket.loose_ml += Number(r.loose_ml || 0);
  bucket.final_total_qty += Number(r.final_total_qty || 0);
  if (r.rate == null) { bucket.no_rate += 1; return; }
  bucket.physical_value += Number(r.physical_value || 0);
  bucket.system_value += Number(r.system_value || 0);
  bucket.variance_value += Number(r.variance_value || 0);
}

// Money is rounded once, at the point it is reported.
function finishBucket(b) {
  const r3 = (n) => Number(Number(n || 0).toFixed(3));
  return {
    ...b,
    physical_value: round2(b.physical_value),
    system_value: round2(b.system_value),
    variance_value: round2(b.variance_value),
    by_location: (b.by_location || []).map(r3),
    location_total: r3(b.location_total),
    loose_ml: r3(b.loose_ml),
    final_total_qty: r3(b.final_total_qty),
    variance_pct: pctOf(b.variance, b.system_qty),
  };
}

const round2 = (n) => Number(Number(n || 0).toFixed(2));
// Quantities are NUMERIC(14,3); rounding once here keeps a float sum from
// printing 1249.9999999999998.
const round3 = (n) => Number(Number(n || 0).toFixed(3));

// Signed variance as a percentage of the system figure. A system figure of zero
// with a variance is 100% (all of it is excess); zero against zero is 0%.
function pctOf(variance, system) {
  if (Number(system) !== 0) return Number(((variance / system) * 100).toFixed(2));
  return variance ? 100 : 0;
}

function groupVariance(rows, locationCount = 0) {
  const bySuper = new Map();
  for (const r of rows) {
    const sKey = r.super_category || '—';
    const cKey = r.category || '—';
    if (!bySuper.has(sKey)) {
      bySuper.set(sKey, { ...emptyBucket({ super_category: sKey }, locationCount), categories: new Map() });
    }
    const s = bySuper.get(sKey);
    if (!s.categories.has(cKey)) {
      s.categories.set(cKey, { ...emptyBucket({ category: cKey, super_category: sKey }, locationCount), rows: [] });
    }
    const c = s.categories.get(cKey);
    addToBucket(s, r);
    addToBucket(c, r);
    c.rows.push(r);
  }
  return [...bySuper.values()].map((s) => ({
    ...finishBucket(s),
    categories: [...s.categories.values()].map(finishBucket),
  }));
}

// ── R4 Variance ─────────────────────────────────────────────────────────────
// Physical − System. While the audit is open this is PROVISIONAL: uncounted
// items would otherwise read as 100% shortages.
export const NO_SYSTEM_DATA = 'NO SYSTEM DATA';
// Flag for a shortage that arises from a missing count rather than a counted
// zero. Both are shortages; only this one means nobody looked.
export const NOT_COUNTED = 'NOT COUNTED';

// Where the system figures came from, so a variance report can always state it.
export async function systemStockSource(auditId) {
  const { rows } = await query(
    `SELECT si.id, si.filename, si.imported_at, si.row_count, si.matched_count,
            si.unmatched_count, si.override_reason, u.name AS imported_by_name
       FROM system_stock_imports si
       LEFT JOIN users u ON u.id = si.imported_by
      WHERE si.audit_id = $1 AND si.status = 'active'
      LIMIT 1`,
    [auditId]
  );
  const { rows: cov } = await query(
    `SELECT (SELECT count(*)::int FROM system_stock WHERE audit_id = $1) AS with_system,
            (SELECT count(*)::int FROM items WHERE is_active = TRUE) AS master_total`,
    [auditId]
  );
  return { source: rows[0] || null, ...cov[0] };
}

// ── Which rows belong on the variance table ─────────────────────────────────
// The item master is shared across every store, but one outlet stocks only a
// subset of it, so "not counted" is the normal state for most items and cannot
// mean the same thing everywhere. Four cases, and only one of them is silent:
//
//   (a) counted + system row      → ordinary variance
//   (b) counted + no system row   → NO SYSTEM DATA (a data gap, not a shortage)
//   (c) NOT counted + system row  → FULL SHORTAGE, flagged NOT COUNTED.
//       The system says stock is there and nobody counted it. That has to be
//       investigated, so it carries its full rupee value into the totals. The
//       flag is what separates it from an item somebody counted and entered as
//       zero — both are shortages, but for completely different reasons.
//   (d) NOT counted + no system row → not stocked at this outlet. Excluded from
//       the table entirely and reported only as a header count, because listing
//       hundreds of items no one ever expected to find buries the real findings.
export function varianceCase(item) {
  if (item.counted) return item.has_system ? 'counted_variance' : 'no_system_data';
  return item.has_system ? 'not_counted' : 'not_stocked';
}

export async function varianceReport(
  auditId,
  { countedOnly = false, countFilter = null, categoryId = null, superCategoryId = null,
    systemData = 'all', rateFilter = 'all', includeNilStock = false } = {}
) {
  const src = await auditSource(auditId);
  const items = await auditItemAggregates(auditId, src);
  const locations = await auditLocations(auditId, src);
  const tol = await getTolerances();
  const audit = await getAudit(auditId);
  const provisional = !audit || audit.status === 'open';
  const provenance = await systemStockSource(auditId);

  // Case (d) leaves the table before any user filter is applied — it is a
  // structural exclusion, not something the admin toggles. Counted separately
  // so the header can still account for every item in the master.
  const notStocked = items.filter((i) => varianceCase(i) === 'not_stocked');
  let source = items.filter((i) => varianceCase(i) !== 'not_stocked');

  // ── Nil-stock rows ───────────────────────────────────────────────────────
  // The standard report carries "items with physical stock only". An item
  // counted at zero with nothing in the system to compare it against says
  // nothing a reader can act on, and hundreds of them bury the real findings.
  //
  // The exclusion is deliberately narrow: a row is only dropped when it has NO
  // system figure. Anything with system stock stays — including a NOT COUNTED
  // row, whose whole point is that the books say stock is there and the shelf
  // was never counted. So no variance and no shortage can be hidden by this.
  // `include_nil=1` puts them back.
  const isNilStock = (i) => !i.has_system
    && Number(i.location_total || 0) === 0
    && Number(i.total_open_ml || 0) === 0;
  const nilStock = includeNilStock ? [] : source.filter(isNilStock);
  if (!includeNilStock) source = source.filter((i) => !isNilStock(i));

  // [All] [Counted] [Not counted with system stock]
  const countMode = countFilter || (countedOnly ? 'counted' : 'all');
  if (countMode === 'counted') source = source.filter((i) => i.counted);
  else if (countMode === 'not_counted') source = source.filter((i) => varianceCase(i) === 'not_counted');

  if (superCategoryId) source = source.filter((i) => String(i.super_category_id) === String(superCategoryId));
  if (categoryId) source = source.filter((i) => String(i.category_id) === String(categoryId));
  // [All] [With system data] [No system data]
  if (systemData === 'with') source = source.filter((i) => i.has_system);
  else if (systemData === 'without') source = source.filter((i) => !i.has_system);
  // [All] [With rate] [No rate] — an item with no rate contributes no value
  // figures, so this isolates exactly what the value columns are missing.
  if (rateFilter === 'with') source = source.filter((i) => i.rate != null);
  else if (rateFilter === 'without') source = source.filter((i) => i.rate == null);

  const rows = source.map((i) => {
    // A MISSING system row is NULL, never zero.
    //   system says 0, physical found 5  → genuine excess, a real variance
    //   no system row at all             → a data gap, not a variance
    // Liquor compares sealed bottles; open ml is reported separately and never
    // folded into the bottle figure.
    const hasSystem = i.has_system;
    const system = hasSystem
      ? (i.is_liquor ? Number(i.system_bottles ?? 0) : Number(i.system_qty ?? 0))
      : null;
    // Case (c): nobody counted it and the system says stock is there. Physical
    // is 0 — which it already is, since there are no entries to sum — so the
    // arithmetic below produces the full shortage with no special casing. What
    // it needs is the FLAG, so a reader can tell this shortage from one where
    // an auditor stood in front of the shelf and entered zero.
    const notCounted = varianceCase(i) === 'not_counted';
    const physical = i.physical_qty;

    // ── Rupee impact ───────────────────────────────────────────────────────
    // A variance report is about the money, not just the count. Three separate
    // figures, because they answer three different questions:
    //   physical_value — what is actually on the shelf
    //   system_value   — what the books say should be there
    //   variance_value — the rupee impact of the difference
    //                    (negative = shortage, positive = excess)
    //
    // A NULL rate is NOT zero. An item priced at ₹0 and an item nobody has
    // priced yet are different things, and averaging a missing rate in as zero
    // would understate every total silently. So all three stay null.
    const rate = i.rate == null ? null : Number(i.rate);
    const money = (qty) => (rate == null || qty == null ? null : round2(qty * rate));

    // The base columns, identical to R1 / R2 / R3.
    const base = standardRow(i);

    // ── Variance and rupee impact ──────────────────────────────────────────
    // Both are measured against FINAL TOTAL QTY, not the native count:
    //
    //   Variance       = Final Total Qty − System Qty
    //   Physical Value = Final Total Qty × Rate
    //   System Value   = System Qty      × Rate
    //   Variance Value = Variance        × Rate
    //
    // A NULL rate is NOT zero. An item priced at ₹0 and an item nobody has
    // priced yet are different things, and averaging a missing rate in as
    // zero would understate every total silently, so all three stay null and
    // the columns print blank.
    const variance = hasSystem ? round3(base.final_total_qty - system) : null;
    const pct = hasSystem ? pctOf(variance, system) : null;

    return {
      ...base,
      rate,
      physical_qty: physical,
      physical_open_ml: i.is_liquor ? Number(i.total_open_ml) : null,
      system_qty: system,
      system_open_ml: i.is_liquor && hasSystem ? Number(i.system_open_ml ?? 0) : null,
      variance,
      variance_pct: pct,
      physical_value: money(base.final_total_qty),
      system_value: money(system),
      variance_value: money(variance),
      counted: i.counted,
      has_system: hasSystem,
      // The flag that explains WHY a row shows a shortage.
      not_counted: notCounted,
      count_status: notCounted ? NOT_COUNTED : 'Counted',
      not_applicable: !!i.not_applicable,
      variance_case: varianceCase(i),
      // Items with no figure are reported as a data gap, not as a shortage.
      status: hasSystem ? bandFor(pct, i.is_liquor, tol) : NO_SYSTEM_DATA,
    };
  });

  // Totals and the overall variance % EXCLUDE rows with no system data.
  const withSystem = rows.filter((r) => r.has_system);
  const noSystem = rows.filter((r) => !r.has_system);

  // The same accumulator the category and super-category subtotals use, so the
  // grand total can never be computed on a different basis from the rows above
  // it. Rupee columns skip items with no rate rather than counting them as 0.
  //
  // Accumulated over EVERY row on the table, not just those with a system
  // figure. The physical columns are the report's spine now and must total to
  // what was actually counted — a physical-only audit has no system rows at
  // all. Variance and value are unaffected: a row without a system figure
  // carries null there and contributes nothing.
  const totalBucket = emptyBucket({}, locations.length);
  for (const r of rows) addToBucket(totalBucket, r);
  const totals = finishBucket(totalBucket);

  const groups = groupVariance(rows, locations.length);

  const total = items.length;
  const counted = items.filter((i) => i.counted || i.not_applicable).length;
  // S.No. and LOC are part of the standard format. S.No. numbers the rows as
  // presented, so it follows the current filter and ordering.
  rows.forEach((r, i) => { r.s_no = i + 1; r.loc = audit?.store_code || ''; });

  return {
    rows,
    groups,
    // GRAND TOTAL for grouped mode, matching R1. Identical to `totals` by
    // construction — both come from the same bucket arithmetic — but exposed
    // separately so the grouped view does not have to reach for the flat one.
    grand: totals,
    // Second sheet of the export.
    summary: buildSummary(rows, groups, audit, locations),
    // The report's columns, in order. The client and the exporter both label
    // from this rather than assuming what the places are called.
    locations,
    provisional,
    progress: { total, counted, uncounted: total - counted },
    // True only when nothing at all has been imported or entered.
    hasSystemStock: provenance.with_system > 0,
    provenance,
    // Case (d): master items neither counted nor present in system stock. Not
    // stocked at this outlet, so they are off the table — but still accounted
    // for here, so nothing in the master goes unexplained.
    notStocked: { count: notStocked.length },
    // Counted at zero, with no system figure to compare against. Reported as a
    // header count so the reader can see what the "physical stock only" basis
    // left out, and recoverable with include_nil=1.
    nilStock: { count: nilStock.length },
    totals: {
      with_system: withSystem.length,
      no_system_data: noSystem.length,
      // Case (c): shortages that exist because nobody counted, not because a
      // count came back short.
      not_counted: rows.filter((r) => r.not_counted).length,
      not_counted_value: round2(
        rows.filter((r) => r.not_counted)
            .reduce((s, r) => s + Number(r.variance_value || 0), 0)),
      not_stocked: notStocked.length,
      // Counted over EVERY row in the current filter, not just those with a
      // system figure: the header states how many items the value columns
      // cannot speak for.
      no_rate: rows.filter((r) => r.rate == null).length,
      // Value is Final Total Qty × Rate, and Final Total Qty is in the BASE
      // measure (ml / gm). For an item whose pack size is greater than 1 the
      // rate must therefore be per ml or per gram, not per pack — a per-pack
      // rate is multiplied by the pack size. Counted so the header can say so
      // rather than letting a reader assume the money is per pack.
      rate_per_base_unit: rows.filter((r) => r.rate != null && Number(r.bottle_unit_size) > 1).length,
      no_rate_with_system: totals.no_rate,
      physical_qty: totals.physical_qty,
      // Standard-report quantity totals, over every row on the table.
      by_location: totals.by_location,
      location_total: totals.location_total,
      loose_ml: totals.loose_ml,
      final_total_qty: totals.final_total_qty,
      system_qty: totals.system_qty,
      variance: totals.variance,
      // Overall %, computed only over rows that actually have a system figure.
      variance_pct: totals.system_qty !== 0 ? totals.variance_pct : null,
      physical_value: totals.physical_value,
      system_value: totals.system_value,
      variance_value: totals.variance_value,
    },
  };
}

// ── Summary report (second sheet of the R4 export) ─────────────────────────
// A header block stating what the audit covered, then one row per category
// under its super category, carrying the five quantity columns. Item counts are
// broken down by measurement basis so a reader can see at a glance how much of
// the master is measured (ML/GM/KG) versus counted (Nos/POR/PKT/PIECE).
function buildSummary(rows, groups, audit, locations = []) {
  const byBasis = {};
  for (const b of BASES) byBasis[b] = 0;
  for (const r of rows) byBasis[r.remarks] = (byBasis[r.remarks] || 0) + 1;

  const categories = groups.flatMap((g) =>
    g.categories.map((c) => ({
      super_category: g.super_category,
      category: c.category,
      items: c.items,
      by_location: c.by_location,
      location_total: c.location_total,
      loose_ml: c.loose_ml,
      final_total_qty: c.final_total_qty,
    }))
  );

  const superCategories = groups.map((g) => ({
    super_category: g.super_category,
    items: g.items,
    by_location: g.by_location,
    location_total: g.location_total,
    loose_ml: g.loose_ml,
    final_total_qty: g.final_total_qty,
  }));

  const grand = superCategories.reduce((t, g) => ({
    items: t.items + g.items,
    by_location: t.by_location.map((v, i) => Number((v + Number(g.by_location?.[i] || 0)).toFixed(3))),
    location_total: Number((t.location_total + g.location_total).toFixed(3)),
    loose_ml: Number((t.loose_ml + g.loose_ml).toFixed(3)),
    final_total_qty: Number((t.final_total_qty + g.final_total_qty).toFixed(3)),
  }), { items: 0, by_location: new Array(locations.length).fill(0),
        location_total: 0, loose_ml: 0, final_total_qty: 0 });

  return {
    header: {
      location: audit?.store_code || audit?.store_name || '',
      store_name: audit?.store_name || '',
      audit_date: audit?.audit_date || null,
      total_items: rows.length,
      locations,
      by_basis: byBasis,
      // The four buckets the standard summary block prints. Everything that is
      // not a volume or a weight collapses into one count-based figure —
      // Nos, Pkt, Por, Piece and Meter are all "how many of them are there",
      // and splitting them across five columns says nothing extra.
      buckets: {
        total: rows.length,
        ml: byBasis.ML || 0,
        gm: byBasis.GM || 0,
        kg: byBasis.KG || 0,
        count_based: rows.length - (byBasis.ML || 0) - (byBasis.GM || 0) - (byBasis.KG || 0),
      },
    },
    superCategories,
    categories,
    grand,
  };
}

// ── R5 Consolidated ─────────────────────────────────────────────────────────
// Store-level comparison plus a SUPER-CATEGORY-level breakdown per store, so
// the same super category can be compared side by side across outlets.
export async function consolidated(auditIds) {
  const stores = [];
  const superRows = [];
  for (const id of auditIds) {
    const audit = await getAudit(id);
    if (!audit) continue;
    const { rows, groups, provisional, progress, totals, hasSystemStock, provenance } =
      await varianceReport(id);
    // `value` became `physical_value` when R4 split it into physical / system /
    // variance. Items with no rate contribute nothing, never a false zero.
    const physicalValue = rows.reduce((s, r) => s + (r.physical_value || 0), 0);
    const critical = rows.filter((r) => r.status === 'Critical').length;
    stores.push({
      audit_id: id, store_name: audit.store_name,
      audit_date: audit.audit_date, status: audit.status,
      items: rows.length, physical_value: round2(physicalValue),
      // Variance totals exclude rows with no system figure.
      total_variance_qty: totals.variance,
      total_variance_value: totals.variance_value,
      critical_items: critical,
      no_system_data: totals.no_system_data,
      has_system_stock: hasSystemStock,
      system_source: provenance.source?.filename ?? null,
      provisional, uncounted: progress.uncounted,
    });
    for (const g of groups) {
      superRows.push({
        store_name: audit.store_name, audit_id: id,
        super_category: g.super_category, items: g.items,
        physical_qty: g.physical_qty, system_qty: g.system_qty,
        variance: g.variance,
        physical_value: g.physical_value, variance_value: g.variance_value,
      });
    }
  }
  return { stores, superCategories: superRows };
}

// R6 — exceptions
// ── Overlap: the same item and location counted by two auditors ────────────
// Auditors can no longer see each other's work, so two of them may count the
// same shelf. Their quantities are SUMMED into the report, which is a double
// count — and nothing in the numbers themselves reveals it.
//
// So it is surfaced, never resolved automatically. Merging or discarding on
// the app's judgement would silently change a recorded count; the admin
// decides, having seen both figures and who entered them.
//
// Read from the same source the report reads: the standing submissions once
// anyone has submitted, the live entries while the count is in progress.
export async function overlaps(auditId, source = null) {
  const src = source || await auditSource(auditId);
  const fromSnapshot = src.mode === SNAPSHOT;
  if (src.mode === CLEARED) return [];

  const sql = fromSnapshot
    ? `SELECT e.item_id, e.location_id, e.counted_by,
              SUM(COALESCE(CASE WHEN i.is_liquor THEN e.bottles ELSE e.qty END, 0)) AS qty,
              SUM(COALESCE(e.open_ml, 0)) AS open_ml
         FROM submission_entries e JOIN items i ON i.id = e.item_id
        WHERE e.submission_id = ANY($1::int[])
        GROUP BY e.item_id, e.location_id, e.counted_by`
    : `SELECT e.item_id, e.location_id, e.counted_by,
              SUM(COALESCE(CASE WHEN i.is_liquor THEN e.bottles ELSE e.qty END, 0)) AS qty,
              SUM(COALESCE(e.open_ml, 0)) AS open_ml
         FROM count_entries e JOIN items i ON i.id = e.item_id
        WHERE e.audit_id = $1 AND e.status = 'active'
        GROUP BY e.item_id, e.location_id, e.counted_by`;

  const { rows } = await query(
    `WITH per_auditor AS (${sql})
     SELECT i.name AS item, i.unit,
            COALESCE(sc.name, '—') AS super_category,
            COALESCE(c.name, '—') AS category,
            COALESCE(l.name, '(no location)') AS location,
            u.name AS auditor, u.username,
            p.qty, p.open_ml
       FROM per_auditor p
       JOIN items i ON i.id = p.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN users u ON u.id = p.counted_by
      WHERE (p.item_id, p.location_id) IN (
        SELECT item_id, location_id FROM per_auditor
         GROUP BY item_id, location_id HAVING count(DISTINCT counted_by) > 1
      )
      ORDER BY i.name, l.sort_order, u.name`,
    [fromSnapshot ? submissionIds(src) : auditId]
  );

  // One row per (item, location) carrying every auditor's figure, so the admin
  // sees the two numbers side by side rather than two rows to correlate.
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.item}|||${r.location}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        item: r.item, unit: r.unit, super_category: r.super_category,
        category: r.category, location: r.location, auditors: [],
      });
    }
    byKey.get(key).auditors.push({
      auditor: r.auditor, username: r.username,
      qty: Number(r.qty), open_ml: Number(r.open_ml),
    });
  }
  return [...byKey.values()];
}

export async function exceptionReport(auditId) {
  // Section and category are joined in here too, so every exception line can be
  // traced back to where the item lives (same join that R2/R4 carry).
  const voided = (await query(
    `SELECT ce.id, i.name, COALESCE(sc.name,'—') AS super_category, COALESCE(c.name,'—') AS category,
            ce.qty, ce.bottles, ce.open_ml, ce.location_text,
            ce.void_reason, u.name AS counted_by_name, vu.name AS voided_by_name, ce.voided_at
       FROM count_entries ce JOIN items i ON i.id=ce.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       JOIN users u ON u.id=ce.counted_by
       LEFT JOIN users vu ON vu.id=ce.voided_by
      WHERE ce.audit_id=$1 AND ce.status='void' ORDER BY ce.voided_at`,
    [auditId]
  )).rows;

  const notApplicable = (await query(
    `SELECT i.name, COALESCE(sc.name,'—') AS super_category, COALESCE(c.name,'—') AS category,
            na.reason, u.name AS marked_by_name, na.marked_at
       FROM audit_na na JOIN items i ON i.id=na.item_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       LEFT JOIN categories c ON c.id = i.category_id
       JOIN users u ON u.id=na.marked_by
      WHERE na.audit_id=$1 ORDER BY i.name`,
    [auditId]
  )).rows;

  const agg = await auditItemAggregates(auditId);
  const multiEntry = [];
  const zeroQty = [];
  const noPhoto = [];
  for (const it of agg) {
    const where = {
      super_category: it.super_category_name || '—',
      category: it.category_name || '—',
      unit: it.unit,
    };
    if (it.entry_count > 1) multiEntry.push({ name: it.name, ...where, entries: it.entry_count, physical_qty: it.physical_qty });
    if (it.entry_count > 0 && it.active_zero > 0) zeroQty.push({ name: it.name, ...where, zero_entries: it.active_zero });
    if (it.entry_count > 0 && it.with_photo === 0) noPhoto.push({ name: it.name, ...where, entries: it.entry_count });
  }
  // Items with NO system figure at all — a data gap, reported separately from
  // any variance so it is never mistaken for a shortage.
  const noSystemData = agg
    .filter((it) => varianceCase(it) === 'no_system_data')
    .map((it) => ({
      name: it.name,
      super_category: it.super_category_name || '—',
      category: it.category_name || '—',
      unit: it.unit,
      physical_qty: it.physical_qty,
      counted: it.entry_count > 0,
    }));

  // Case (c) — the system says stock is here and nobody counted it. Every one
  // of these is a full shortage that nobody has looked at, which is exactly
  // what an exception report exists to surface.
  const notCounted = agg
    .filter((it) => varianceCase(it) === 'not_counted')
    .map((it) => {
      const system = it.is_liquor ? Number(it.system_bottles ?? 0) : Number(it.system_qty ?? 0);
      const rate = it.rate == null ? null : Number(it.rate);
      return {
        name: it.name,
        super_category: it.super_category_name || '—',
        category: it.category_name || '—',
        unit: it.unit,
        system_qty: system,
        // Physical is zero, so the shortage is the whole system figure.
        shortage_qty: -system,
        shortage_value: rate == null ? null : round2(-system * rate),
        // A deliberate Not Applicable is still uncounted, but the auditor said
        // so on purpose — worth distinguishing when chasing these up.
        not_applicable: !!it.not_applicable,
      };
    });

  // Case (d) — reported as a count only. Listing hundreds of items the outlet
  // never stocked would bury every real exception above.
  const notStockedCount = agg.filter((it) => varianceCase(it) === 'not_stocked').length;

  return { voided, notApplicable, multiEntry, zeroQty, noPhoto, noSystemData,
           notCounted, notStockedCount,
           // The same shelf counted twice, by two people who could not see
           // each other. Reported, never resolved automatically.
           overlaps: await overlaps(auditId) };
}
