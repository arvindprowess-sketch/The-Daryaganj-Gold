// ═══════════════════════════════════════════════════════════════════════════
// The client's real inventory hierarchy.
//
// These names are used EXACTLY as the client writes them — same spelling, same
// case, same spacing. They must match the client's system so our reports
// reconcile without manual translation. Do NOT "tidy" them (no title-casing,
// no renaming, no re-ordering for looks).
//
// Structure: super category → categories
// ═══════════════════════════════════════════════════════════════════════════

export const HIERARCHY = [
  {
    name: 'FOOD',
    categories: ['PROVISION', 'SEMI FINISHED', 'VEGETABLES & FRUITS', 'BUTCHERY', 'DAIRY'],
  },
  {
    name: 'NON FOOD',
    categories: ['CONSUMABLE', 'PRINTABLE', 'HK', 'CHEMICAL', 'PACKAGING'],
  },
  {
    name: 'CCG',
    categories: ['BAR WARE', 'BAR GLASSWARE', 'CROCKERY', 'CUTLERY', 'SERVICE WARE'],
  },
  {
    name: 'LIQUOR',
    categories: ['LIQUOR'],
  },
  {
    name: 'BEVERAGES',
    categories: ['BEVERAGES'],
  },
];

// Installs (or tops up) the hierarchy. Idempotent: existing rows are matched
// case-insensitively by name and left in place, so admin-created additions
// survive a re-seed of the structure.
export async function ensureHierarchy(client) {
  const superIds = {};
  const categoryIds = {};

  for (const [index, sc] of HIERARCHY.entries()) {
    const { rows } = await client.query(
      `INSERT INTO super_categories (name, sort_order, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (lower(name)) DO UPDATE SET sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [sc.name, index + 1]
    );
    superIds[sc.name] = rows[0].id;

    for (const cat of sc.categories) {
      const { rows: cr } = await client.query(
        `INSERT INTO categories (name, super_category_id, is_active)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (super_category_id, lower(name)) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [cat, superIds[sc.name]]
      );
      // Categories are keyed by "SUPER/CATEGORY" because a category name may
      // legitimately repeat under a different super category.
      categoryIds[`${sc.name}/${cat}`] = cr[0].id;
    }
  }
  return { superIds, categoryIds };
}
