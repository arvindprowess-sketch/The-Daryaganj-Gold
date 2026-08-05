import { pool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { ensureHierarchy } from './hierarchy.js';
import { loadItemMaster, REAL_CSV } from './itemMaster.js';

// Deterministic demo dataset. Safe to re-run: it clears the demo tables first.
async function seed() {
  const { items: master, source } = loadItemMaster();

  const summary = await withTransaction(async (c) => {
    // Reset (order matters for FKs)
    await c.query(`TRUNCATE photo_reviews, audit_na, system_stock, count_entries, audits,
      items, categories, super_categories, user_stores, users, stores RESTART IDENTITY CASCADE`);

    // ── The client's real hierarchy (5 super categories) ───────────────────
    const { superIds, categoryIds } = await ensureHierarchy(c);

    // ── Store: M3M ─────────────────────────────────────────────────────────
    const { rows: storeRows } = await c.query(
      `INSERT INTO stores (code, name, address) VALUES ($1,$2,$3) RETURNING id`,
      ['M3M', 'M3M', 'M3M, Gurugram']
    );
    const storeId = storeRows[0].id;

    // ── Users (unchanged) ──────────────────────────────────────────────────
    const creds = [
      { username: 'admin', name: 'Admin (Audix)', role: 'admin', password: 'admin123', stores: [] },
      { username: 'rakesh', name: 'Rakesh Kumar', role: 'auditor', password: 'rakesh123', stores: [storeId] },
      { username: 'sunil', name: 'Sunil Verma', role: 'auditor', password: 'sunil123', stores: [storeId] },
    ];
    const userIds = {};
    for (const u of creds) {
      const hash = await hashPassword(u.password);
      const { rows } = await c.query(
        'INSERT INTO users (username, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [u.username, u.name, hash, u.role]
      );
      userIds[u.username] = rows[0].id;
      for (const sid of u.stores) {
        await c.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1,$2)', [rows[0].id, sid]);
      }
    }

    // ── Item master ────────────────────────────────────────────────────────
    // Unit is inserted verbatim — no normalisation, no substitution.
    const itemIds = {};
    let liquorCount = 0;
    for (const it of master) {
      const catId = categoryIds[`${it.super_category}/${it.category}`] ?? null;
      const superId = superIds[it.super_category] ?? null;
      const { rows } = await c.query(
        `INSERT INTO items (name, super_category_id, category_id, unit, is_liquor, bottle_size_ml, rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (lower(name)) DO NOTHING
         RETURNING id`,
        [it.item_name, superId, catId, it.unit, it.is_liquor, it.bottle_size_ml, it.rate]
      );
      if (rows[0]) {
        itemIds[it.item_name.toLowerCase()] = rows[0].id;
        if (it.is_liquor) liquorCount++;
      }
    }

    // ── One open audit with sample entries ─────────────────────────────────
    const { rows: auditRows } = await c.query(
      `INSERT INTO audits (store_id, audit_date, cutoff_time, status, created_by)
       VALUES ($1, CURRENT_DATE, '6:00 PM', 'open', $2) RETURNING id`,
      [storeId, userIds['admin']]
    );
    const auditId = auditRows[0].id;
    const rakesh = userIds['rakesh'];
    const sunil = userIds['sunil'];

    const idOf = (name) => itemIds[name.toLowerCase()];
    const mkEntry = (itemName, f) => {
      const id = idOf(itemName);
      if (!id) return null;
      return c.query(
        `INSERT INTO count_entries (audit_id, item_id, qty, bottles, open_ml, location_text,
           remarks, counted_by, status, void_reason, voided_by, voided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [auditId, id, f.qty ?? null, f.bottles ?? null, f.open_ml ?? null, f.location ?? null,
         f.remarks ?? null, f.by ?? rakesh, f.status ?? 'active', f.void_reason ?? null,
         f.voided_by ?? null, f.voided_at ?? null]
      );
    };

    // Pick representative items that exist in whichever master was loaded.
    const nonLiquor = master.filter((m) => !m.is_liquor);
    const liquor = master.filter((m) => m.is_liquor);
    const pick = (n) => nonLiquor[n]?.item_name;

    // One item counted at TWO locations (append-only is visible immediately).
    const twoLoc = pick(0);
    if (twoLoc) {
      await mkEntry(twoLoc, { qty: 1.0, location: 'Dry Store', by: rakesh });
      await mkEntry(twoLoc, { qty: 2.0, location: 'Basement rack', by: rakesh });
    }

    // One VOIDED entry, kept visible and excluded from totals.
    const voided = pick(1);
    if (voided) {
      await mkEntry(voided, { qty: 99, location: 'Dry Store', by: rakesh, status: 'void',
        void_reason: 'Miscounted sacks — re-counted below',
        voided_by: rakesh, voided_at: new Date().toISOString() });
      await mkEntry(voided, { qty: 40, location: 'Dry Store', by: rakesh });
    }

    if (pick(2)) await mkEntry(pick(2), { qty: 25, location: 'Dry Store', by: sunil });
    if (pick(3)) await mkEntry(pick(3), { qty: 8.5, location: 'Cold room', by: sunil });
    // Explicit zero: counted, found none — different from "not yet counted".
    if (pick(4)) await mkEntry(pick(4), { qty: 0, location: 'Freezer 2', remarks: 'Out of stock', by: rakesh });

    // Liquor: bottles and open ml stay separate.
    if (liquor[0]) await mkEntry(liquor[0].item_name, { bottles: 3, open_ml: 400, location: 'Bar shelf', by: rakesh });
    if (liquor[1]) await mkEntry(liquor[1].item_name, { bottles: 5, open_ml: 0, location: 'Bar store', by: rakesh });

    // System stock for a handful of items so variance has something to compare.
    const sysNonLiquor = [[pick(0), 3], [pick(1), 42], [pick(2), 25], [pick(3), 9]];
    for (const [name, qty] of sysNonLiquor) {
      const id = name && idOf(name);
      if (id) {
        await c.query(
          'INSERT INTO system_stock (audit_id, item_id, qty, created_by) VALUES ($1,$2,$3,$4)',
          [auditId, id, qty, userIds['admin']]
        );
      }
    }
    if (liquor[0] && idOf(liquor[0].item_name)) {
      await c.query(
        'INSERT INTO system_stock (audit_id, item_id, bottles, open_ml, created_by) VALUES ($1,$2,$3,$4,$5)',
        [auditId, idOf(liquor[0].item_name), 3, 400, userIds['admin']]
      );
    }
    if (liquor[1] && idOf(liquor[1].item_name)) {
      await c.query(
        'INSERT INTO system_stock (audit_id, item_id, bottles, open_ml, created_by) VALUES ($1,$2,$3,$4,$5)',
        [auditId, idOf(liquor[1].item_name), 6, 0, userIds['admin']]
      );
    }

    const { rows: counts } = await c.query(
      `SELECT (SELECT count(*) FROM items)::int AS items,
              (SELECT count(*) FROM items WHERE is_liquor)::int AS liquor,
              (SELECT count(*) FROM super_categories)::int AS supers,
              (SELECT count(*) FROM categories)::int AS cats`
    );
    return { ...counts[0], liquorCount };
  });

  console.log('\n════════════════════════════════════════════');
  console.log(' Seed complete.');
  console.log('════════════════════════════════════════════');
  console.log(` Store        : M3M`);
  console.log(` Hierarchy    : ${summary.supers} super categories, ${summary.cats} categories`);
  console.log(` Item master  : ${summary.items} items (${summary.liquor} liquor)`);
  if (source === 'client-csv') {
    console.log(` Source       : Item_Master_Import_Ready.csv (client data)`);
  } else {
    console.log('');
    console.log(' ⚠  Item_Master_Import_Ready.csv was NOT found, so a STAND-IN');
    console.log('    master was generated at the same volume and distribution.');
    console.log('    These item names are placeholders, NOT client data.');
    console.log('    To seed the real master, drop the file at:');
    console.log(`      ${REAL_CSV}`);
    console.log('    and re-run `npm run seed`.');
  }
  console.log('════════════════════════════════════════════');
  console.log(' ADMIN    username: admin    password: admin123');
  console.log(' AUDITOR  username: rakesh   password: rakesh123  (M3M)');
  console.log(' AUDITOR  username: sunil    password: sunil123   (M3M)');
  console.log('════════════════════════════════════════════\n');
  await pool.end();
}

seed().catch((err) => { console.error(err); process.exit(1); });
