// ═══════════════════════════════════════════════════════════════════════════
// seed:reference — the client's super categories and categories ONLY.
//
// Safe to run anywhere, including production: it creates NO users, NO items,
// NO stores, NO audits and NO count entries. It is idempotent, so running it
// again on a live database tops the hierarchy up without disturbing anything.
// ═══════════════════════════════════════════════════════════════════════════
import { pool, withTransaction } from '../src/db.js';
import { ensureHierarchy, HIERARCHY } from './hierarchy.js';
import { assertSeedAllowed } from './guard.js';

async function main() {
  assertSeedAllowed('seed:reference', { allowInProduction: true });

  const counts = await withTransaction(async (c) => {
    await ensureHierarchy(c);
    const { rows } = await c.query(
      `SELECT (SELECT count(*)::int FROM super_categories) AS supers,
              (SELECT count(*)::int FROM categories) AS cats`
    );
    return rows[0];
  });

  console.log('\n════════════════════════════════════════════');
  console.log(' Reference data seeded (hierarchy only).');
  console.log('════════════════════════════════════════════');
  console.log(` Super categories : ${counts.supers}`);
  console.log(` Categories       : ${counts.cats}`);
  console.log(` Defined          : ${HIERARCHY.map((h) => h.name).join(', ')}`);
  console.log(' No users, items, stores, audits or entries were created.');
  console.log('════════════════════════════════════════════\n');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
