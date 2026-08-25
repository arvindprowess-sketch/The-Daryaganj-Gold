import { query } from '../db.js';
import { measurementBasis, finalTotals, BASES } from './measure.js';

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
export async function auditItemAggregates(auditId) {
  const { rows } = await query(
    `SELECT i.id, i.name, i.unit, i.is_liquor, i.bottle_size_ml, i.bottle_unit_size, i.rate,
            i.super_category_id, i.category_id,
            sc.name AS super_category_name, c.name AS category_name,
            COALESCE(agg.total_qty, 0)      AS total_qty,
            COALESCE(agg.total_bottles, 0)  AS total_bottles,
            COALESCE(agg.total_open_ml, 0)  AS total_open_ml,
            -- Physical quantity split by ZONE, from the location recorded on
            -- each entry. An entry whose location is not in location_zones
            -- falls to the configured default so no quantity is ever dropped.
            COALESCE(agg.store_room_qty, 0) AS store_room_qty,
            COALESCE(agg.outlet_qty, 0)     AS outlet_qty,
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
                SUM(native) FILTER (WHERE zone = 'store_room') AS store_room_qty,
                SUM(native) FILTER (WHERE zone = 'outlet')     AS outlet_qty,
                COUNT(*) FILTER (WHERE COALESCE(qty,0)=0 AND COALESCE(bottles,0)=0 AND COALESCE(open_ml,0)=0) AS active_zero,
                COUNT(*) FILTER (WHERE photo_url IS NOT NULL) AS with_photo
           FROM (
             SELECT ce.qty, ce.bottles, ce.open_ml, ce.photo_url,
                    -- Liquor counts in sealed bottles; everything else in its
                    -- own unit. Open ml is NEVER folded in here.
                    COALESCE(CASE WHEN i.is_liquor THEN ce.bottles ELSE ce.qty END, 0) AS native,
                    COALESCE(lz.zone, $2) AS zone
               FROM count_entries ce
               LEFT JOIN location_zones lz
                      ON lower(btrim(lz.name)) = lower(btrim(COALESCE(ce.location_text, '')))
              WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status='active'
           ) e
       ) agg ON TRUE
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
       LEFT JOIN audit_na na ON na.item_id = i.id AND na.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
    [auditId, await defaultZone()]
  );
  return rows.map((r) => {
    const physicalQty = r.is_liquor ? Number(r.total_bottles) : Number(r.total_qty);
    const value = r.rate != null ? physicalQty * Number(r.rate) : null;
    // Store Room + Outlet must always reconcile to the item's physical total,
    // whatever the zone mapping says.
    return {
      ...r,
      physical_qty: physicalQty,
      store_room_qty: Number(r.store_room_qty),
      outlet_qty: Number(r.outlet_qty),
      bottle_unit_size: Number(r.bottle_unit_size ?? 1),
      value,
      counted: r.entry_count > 0,
    };
  });
}

// Where an entry whose location is not in location_zones is counted. Explicit
// and admin-editable, so a quantity is never silently dropped from both columns.
export async function defaultZone() {
  const { rows } = await query(`SELECT value FROM settings WHERE key='location_default_zone'`);
  return rows[0]?.value === 'store_room' ? 'store_room' : 'outlet';
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

// ── R1 Physical Stock Summary ───────────────────────────────────────────────
// Grouped by super category, then category, with a subtotal per category, a
// subtotal per super category, and a grand total.
export async function physicalSummary(auditId) {
  const items = await auditItemAggregates(auditId);

  const bySuper = new Map();
  for (const it of items) {
    const sKey = it.super_category_name || 'Unassigned';
    const cKey = it.category_name || 'Unassigned';
    if (!bySuper.has(sKey)) {
      bySuper.set(sKey, { super_category: sKey, qty: 0, value: 0, items: 0, categories: new Map() });
    }
    const s = bySuper.get(sKey);
    s.qty += it.physical_qty; s.value += it.value || 0; s.items += 1;
    if (!s.categories.has(cKey)) {
      s.categories.set(cKey, { super_category: sKey, category: cKey, qty: 0, value: 0, items: 0 });
    }
    const c = s.categories.get(cKey);
    c.qty += it.physical_qty; c.value += it.value || 0; c.items += 1;
  }

  const groups = [...bySuper.values()].map((s) => ({
    super_category: s.super_category,
    qty: s.qty, value: s.value, items: s.items,
    categories: [...s.categories.values()],
  }));

  const grand = groups.reduce(
    (t, g) => ({ qty: t.qty + g.qty, value: t.value + g.value, items: t.items + g.items }),
    { qty: 0, value: 0, items: 0 }
  );

  // Flat category list retained for callers that want a single table.
  const categories = groups.flatMap((g) => g.categories);
  return { groups, categories, superCategories: groups.map(({ categories: _c, ...s }) => s), grand };
}

// ── R2 Item Detail — REPORT view: TOTALS ONLY ───────────────────────────────
// One line per item carrying its total. No per-entry lines and no redundant
// "<item> Total" row. Section and category are included (the join that was
// missing). The per-entry breakdown still exists in the database and on the
// admin count screen — it simply never appears in a client report.
export async function itemDetailTotals(auditId) {
  const items = await auditItemAggregates(auditId);
  return items
    .filter((i) => i.entry_count > 0 || i.not_applicable)
    .map((i) => ({
      name: i.name,
      super_category: i.super_category_name || '—',
      category: i.category_name || '—',
      // Unit is displayed exactly as the master supplies it.
      unit: i.unit,
      is_liquor: i.is_liquor,
      total_qty: i.is_liquor ? null : Number(i.total_qty),
      total_bottles: i.is_liquor ? Number(i.total_bottles) : null,
      total_open_ml: i.is_liquor ? Number(i.total_open_ml) : null,
      not_applicable: i.not_applicable,
    }));
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
            ce.status, ce.void_reason, ce.counted_at, u.name AS counted_by_name
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
  const items = (await auditItemAggregates(auditId)).filter((i) => i.is_liquor);
  // Structure unchanged: bottles and ml stay separate and are never combined.
  // Super category and category added for consistency with the other reports.
  return items.map((i) => ({
    super_category: i.super_category_name || '—',
    category: i.category_name || '—',
    brand: i.bottle_size_ml ? `${i.name} ${i.bottle_size_ml}ml` : i.name,
    unit: i.unit,
    sealed_bottles: Number(i.total_bottles),
    open_ml: Number(i.total_open_ml),
  }));
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
function emptyBucket(extra) {
  return {
    ...extra, items: 0, no_rate: 0,
    physical_qty: 0, system_qty: 0, variance: 0,
    physical_value: 0, system_value: 0, variance_value: 0,
    // Standard-report quantity columns, subtotalled alongside the rest.
    store_room_qty: 0, outlet_qty: 0, store_outlet_total: 0,
    loose_ml: 0, final_total_qty: 0,
  };
}

function addToBucket(bucket, r) {
  bucket.items += 1;
  bucket.physical_qty += Number(r.physical_qty || 0);
  bucket.system_qty += Number(r.system_qty || 0);
  bucket.variance += Number(r.variance || 0);
  bucket.store_room_qty += Number(r.store_room_qty || 0);
  bucket.outlet_qty += Number(r.outlet_qty || 0);
  bucket.store_outlet_total += Number(r.store_outlet_total || 0);
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
    store_room_qty: r3(b.store_room_qty),
    outlet_qty: r3(b.outlet_qty),
    store_outlet_total: r3(b.store_outlet_total),
    loose_ml: r3(b.loose_ml),
    final_total_qty: r3(b.final_total_qty),
    variance_pct: pctOf(b.variance, b.system_qty),
  };
}

const round2 = (n) => Number(Number(n || 0).toFixed(2));

// Signed variance as a percentage of the system figure. A system figure of zero
// with a variance is 100% (all of it is excess); zero against zero is 0%.
function pctOf(variance, system) {
  if (Number(system) !== 0) return Number(((variance / system) * 100).toFixed(2));
  return variance ? 100 : 0;
}

function groupVariance(rows) {
  const bySuper = new Map();
  for (const r of rows) {
    const sKey = r.super_category || '—';
    const cKey = r.category || '—';
    if (!bySuper.has(sKey)) {
      bySuper.set(sKey, { ...emptyBucket({ super_category: sKey }), categories: new Map() });
    }
    const s = bySuper.get(sKey);
    if (!s.categories.has(cKey)) {
      s.categories.set(cKey, { ...emptyBucket({ category: cKey, super_category: sKey }), rows: [] });
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
    systemData = 'all', rateFilter = 'all' } = {}
) {
  const items = await auditItemAggregates(auditId);
  const tol = await getTolerances();
  const audit = await getAudit(auditId);
  const provisional = !audit || audit.status === 'open';
  const provenance = await systemStockSource(auditId);

  // Case (d) leaves the table before any user filter is applied — it is a
  // structural exclusion, not something the admin toggles. Counted separately
  // so the header can still account for every item in the master.
  const notStocked = items.filter((i) => varianceCase(i) === 'not_stocked');
  let source = items.filter((i) => varianceCase(i) !== 'not_stocked');

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
    const variance = hasSystem ? physical - system : null;
    const pct = hasSystem ? pctOf(variance, system) : null;

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

    // ── Standard audit report figures ──────────────────────────────────────
    // Physical quantity split by zone, then carried through the one formula
    // that covers the whole master:
    //   Final Total Qty = (Store Room + Outlet) × Bottle/Unit Size + Loose ML
    const measures = finalTotals({
      storeRoom: i.store_room_qty,
      outlet: i.outlet_qty,
      size: i.bottle_unit_size,
      looseMl: i.total_open_ml,
    });

    return {
      name: i.name, unit: i.unit, is_liquor: i.is_liquor,
      super_category: i.super_category_name || '—', category: i.category_name || '—',
      super_category_id: i.super_category_id, category_id: i.category_id,
      rate,
      bottle_unit_size: Number(i.bottle_unit_size ?? 1),
      ...measures,
      // What Final Total Qty is expressed in.
      remarks: measurementBasis(i.unit),
      physical_qty: physical,
      physical_open_ml: i.is_liquor ? Number(i.total_open_ml) : null,
      system_qty: system,
      system_open_ml: i.is_liquor && hasSystem ? Number(i.system_open_ml ?? 0) : null,
      variance,
      variance_pct: pct,
      physical_value: money(physical),
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
  const totalBucket = emptyBucket({});
  for (const r of rows) addToBucket(totalBucket, r);
  const totals = finishBucket(totalBucket);

  const groups = groupVariance(rows);

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
    summary: buildSummary(rows, groups, audit),
    provisional,
    progress: { total, counted, uncounted: total - counted },
    // True only when nothing at all has been imported or entered.
    hasSystemStock: provenance.with_system > 0,
    provenance,
    // Case (d): master items neither counted nor present in system stock. Not
    // stocked at this outlet, so they are off the table — but still accounted
    // for here, so nothing in the master goes unexplained.
    notStocked: { count: notStocked.length },
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
      no_rate_with_system: totals.no_rate,
      physical_qty: totals.physical_qty,
      // Standard-report quantity totals, over every row on the table.
      store_room_qty: totals.store_room_qty,
      outlet_qty: totals.outlet_qty,
      store_outlet_total: totals.store_outlet_total,
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
function buildSummary(rows, groups, audit) {
  const byBasis = {};
  for (const b of BASES) byBasis[b] = 0;
  for (const r of rows) byBasis[r.remarks] = (byBasis[r.remarks] || 0) + 1;

  const categories = groups.flatMap((g) =>
    g.categories.map((c) => ({
      super_category: g.super_category,
      category: c.category,
      items: c.items,
      store_room_qty: c.store_room_qty,
      outlet_qty: c.outlet_qty,
      store_outlet_total: c.store_outlet_total,
      loose_ml: c.loose_ml,
      final_total_qty: c.final_total_qty,
    }))
  );

  const superCategories = groups.map((g) => ({
    super_category: g.super_category,
    items: g.items,
    store_room_qty: g.store_room_qty,
    outlet_qty: g.outlet_qty,
    store_outlet_total: g.store_outlet_total,
    loose_ml: g.loose_ml,
    final_total_qty: g.final_total_qty,
  }));

  const grand = superCategories.reduce((t, g) => ({
    items: t.items + g.items,
    store_room_qty: Number((t.store_room_qty + g.store_room_qty).toFixed(3)),
    outlet_qty: Number((t.outlet_qty + g.outlet_qty).toFixed(3)),
    store_outlet_total: Number((t.store_outlet_total + g.store_outlet_total).toFixed(3)),
    loose_ml: Number((t.loose_ml + g.loose_ml).toFixed(3)),
    final_total_qty: Number((t.final_total_qty + g.final_total_qty).toFixed(3)),
  }), { items: 0, store_room_qty: 0, outlet_qty: 0, store_outlet_total: 0, loose_ml: 0, final_total_qty: 0 });

  return {
    header: {
      location: audit?.store_code || audit?.store_name || '',
      store_name: audit?.store_name || '',
      audit_date: audit?.audit_date || null,
      total_items: rows.length,
      by_basis: byBasis,
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
           notCounted, notStockedCount };
}
