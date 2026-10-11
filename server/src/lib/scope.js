// ═══════════════════════════════════════════════════════════════════════════
// Which items an audit is about.
//
// Cafe items (the Item Master) and warehouse articles (the Stock list) live in
// one table, told apart by items.inventory_mode. An audit covers the items of
// its STORE's mode — never the other side's — and every query that lists or
// counts "the master" for an audit goes through this one expression.
// ═══════════════════════════════════════════════════════════════════════════

// The audited store's mode, as a SQL scalar. `p` is the placeholder holding
// the audit id.
export const AUDIT_MODE = (p = '$1') =>
  `(SELECT s.inventory_mode FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id = ${p})`;

// Ids of the Item Master's own items, for scoping its imports and deletes.
export const CAFE_ITEM_IDS = `(SELECT id FROM items WHERE inventory_mode = 'cafe')`;
