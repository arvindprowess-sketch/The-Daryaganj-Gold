import { query } from '../db.js';

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
    `SELECT i.id, i.name, i.unit, i.is_liquor, i.bottle_size_ml, i.rate,
            i.super_category_id, i.category_id,
            sc.name AS super_category_name, c.name AS category_name,
            COALESCE(agg.total_qty, 0)      AS total_qty,
            COALESCE(agg.total_bottles, 0)  AS total_bottles,
            COALESCE(agg.total_open_ml, 0)  AS total_open_ml,
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
         SELECT SUM(qty) AS total_qty, SUM(bottles) AS total_bottles,
                SUM(open_ml) AS total_open_ml, COUNT(*) AS entry_count,
                COUNT(*) FILTER (WHERE COALESCE(qty,0)=0 AND COALESCE(bottles,0)=0 AND COALESCE(open_ml,0)=0) AS active_zero,
                COUNT(*) FILTER (WHERE photo_url IS NOT NULL) AS with_photo
           FROM count_entries ce
          WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status='active'
       ) agg ON TRUE
       LEFT JOIN system_stock ss ON ss.item_id = i.id AND ss.audit_id = $1
       LEFT JOIN audit_na na ON na.item_id = i.id AND na.audit_id = $1
      WHERE i.is_active = TRUE
      ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
    [auditId]
  );
  return rows.map((r) => {
    const physicalQty = r.is_liquor ? Number(r.total_bottles) : Number(r.total_qty);
    const value = r.rate != null ? physicalQty * Number(r.rate) : null;
    return { ...r, physical_qty: physicalQty, value, counted: r.entry_count > 0 };
  });
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
  };
}

function addToBucket(bucket, r) {
  bucket.items += 1;
  bucket.physical_qty += Number(r.physical_qty || 0);
  bucket.system_qty += Number(r.system_qty || 0);
  bucket.variance += Number(r.variance || 0);
  if (r.rate == null) { bucket.no_rate += 1; return; }
  bucket.physical_value += Number(r.physical_value || 0);
  bucket.system_value += Number(r.system_value || 0);
  bucket.variance_value += Number(r.variance_value || 0);
}

// Money is rounded once, at the point it is reported.
function finishBucket(b) {
  return {
    ...b,
    physical_value: round2(b.physical_value),
    system_value: round2(b.system_value),
    variance_value: round2(b.variance_value),
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

export async function varianceReport(
  auditId,
  { countedOnly = false, categoryId = null, superCategoryId = null, systemData = 'all',
    rateFilter = 'all' } = {}
) {
  const items = await auditItemAggregates(auditId);
  const tol = await getTolerances();
  const audit = await getAudit(auditId);
  const provisional = !audit || audit.status === 'open';
  const provenance = await systemStockSource(auditId);

  let source = countedOnly ? items.filter((i) => i.counted) : items;
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

    return {
      name: i.name, unit: i.unit, is_liquor: i.is_liquor,
      super_category: i.super_category_name || '—', category: i.category_name || '—',
      super_category_id: i.super_category_id, category_id: i.category_id,
      rate,
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
  const totalBucket = emptyBucket({});
  for (const r of withSystem) addToBucket(totalBucket, r);
  const totals = finishBucket(totalBucket);

  const groups = groupVariance(withSystem);

  const total = items.length;
  const counted = items.filter((i) => i.counted || i.not_applicable).length;
  return {
    rows,
    groups,
    // GRAND TOTAL for grouped mode, matching R1. Identical to `totals` by
    // construction — both come from the same bucket arithmetic — but exposed
    // separately so the grouped view does not have to reach for the flat one.
    grand: totals,
    provisional,
    progress: { total, counted, uncounted: total - counted },
    // True only when nothing at all has been imported or entered.
    hasSystemStock: provenance.with_system > 0,
    provenance,
    totals: {
      with_system: withSystem.length,
      no_system_data: noSystem.length,
      // Counted over EVERY row in the current filter, not just those with a
      // system figure: the header states how many items the value columns
      // cannot speak for.
      no_rate: rows.filter((r) => r.rate == null).length,
      no_rate_with_system: totals.no_rate,
      physical_qty: totals.physical_qty,
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
    .filter((it) => !it.has_system)
    .map((it) => ({
      name: it.name,
      super_category: it.super_category_name || '—',
      category: it.category_name || '—',
      unit: it.unit,
      physical_qty: it.physical_qty,
      counted: it.entry_count > 0,
    }));

  return { voided, notApplicable, multiEntry, zeroQty, noPhoto, noSystemData };
}
