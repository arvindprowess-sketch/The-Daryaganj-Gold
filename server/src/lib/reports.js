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
function groupVariance(rows) {
  const bySuper = new Map();
  for (const r of rows) {
    const sKey = r.super_category || '—';
    const cKey = r.category || '—';
    if (!bySuper.has(sKey)) {
      bySuper.set(sKey, {
        super_category: sKey, items: 0, physical_qty: 0, system_qty: 0,
        variance: 0, value: 0, categories: new Map(),
      });
    }
    const s = bySuper.get(sKey);
    if (!s.categories.has(cKey)) {
      s.categories.set(cKey, {
        category: cKey, items: 0, physical_qty: 0, system_qty: 0,
        variance: 0, value: 0, rows: [],
      });
    }
    const c = s.categories.get(cKey);
    for (const bucket of [s, c]) {
      bucket.items += 1;
      bucket.physical_qty += Number(r.physical_qty || 0);
      bucket.system_qty += Number(r.system_qty || 0);
      bucket.variance += Number(r.variance || 0);
      bucket.value += Number(r.value || 0);
    }
    c.rows.push(r);
  }
  return [...bySuper.values()].map((s) => ({
    ...s, categories: [...s.categories.values()],
  }));
}

// ── R4 Variance ─────────────────────────────────────────────────────────────
// Physical − System. While the audit is open this is PROVISIONAL: uncounted
// items would otherwise read as 100% shortages.
export async function varianceReport(
  auditId,
  { countedOnly = false, categoryId = null, superCategoryId = null } = {}
) {
  const items = await auditItemAggregates(auditId);
  const tol = await getTolerances();
  const audit = await getAudit(auditId);
  const provisional = !audit || audit.status === 'open';

  let source = countedOnly ? items.filter((i) => i.counted) : items;
  if (superCategoryId) source = source.filter((i) => String(i.super_category_id) === String(superCategoryId));
  if (categoryId) source = source.filter((i) => String(i.category_id) === String(categoryId));

  const rows = source.map((i) => {
    // Liquor compares sealed bottles; open ml is reported separately and never
    // folded into the bottle figure.
    const system = i.has_system
      ? (i.is_liquor ? Number(i.system_bottles ?? 0) : Number(i.system_qty ?? 0))
      : null;
    const physical = i.physical_qty;
    const variance = system != null ? physical - system : null;
    const pct = system && system !== 0 ? (variance / system) * 100 : (variance ? 100 : 0);
    return {
      name: i.name, unit: i.unit, is_liquor: i.is_liquor,
      super_category: i.super_category_name || '—', category: i.category_name || '—',
      super_category_id: i.super_category_id, category_id: i.category_id,
      physical_qty: physical,
      physical_open_ml: i.is_liquor ? Number(i.total_open_ml) : null,
      system_qty: system,
      system_open_ml: i.is_liquor && i.has_system ? Number(i.system_open_ml ?? 0) : null,
      variance, variance_pct: system != null ? Number(pct.toFixed(2)) : null,
      value: i.value,
      counted: i.counted,
      status: system != null ? bandFor(pct, i.is_liquor, tol) : 'No system stock',
    };
  });

  const total = items.length;
  const counted = items.filter((i) => i.counted || i.not_applicable).length;
  return {
    rows,
    groups: groupVariance(rows),
    provisional,
    progress: { total, counted, uncounted: total - counted },
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
    const { rows, groups, provisional, progress } = await varianceReport(id);
    const physicalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
    const totalVariance = rows.reduce((s, r) => s + (r.variance || 0), 0);
    const critical = rows.filter((r) => r.status === 'Critical').length;
    stores.push({
      audit_id: id, store_name: audit.store_name,
      audit_date: audit.audit_date, status: audit.status,
      items: rows.length, physical_value: physicalValue,
      total_variance_qty: totalVariance, critical_items: critical,
      provisional, uncounted: progress.uncounted,
    });
    for (const g of groups) {
      superRows.push({
        store_name: audit.store_name, audit_id: id,
        super_category: g.super_category, items: g.items,
        physical_qty: g.physical_qty, system_qty: g.system_qty,
        variance: g.variance, value: g.value,
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
  return { voided, notApplicable, multiEntry, zeroQty, noPhoto };
}
