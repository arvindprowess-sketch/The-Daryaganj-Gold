import { pool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';

// Deterministic demo dataset. Safe to re-run: it clears the demo tables first.
async function seed() {
  await withTransaction(async (c) => {
    // Reset (order matters for FKs)
    await c.query(`TRUNCATE audit_na, system_stock, count_entries, audits,
      items, categories, sections, user_stores, users, stores RESTART IDENTITY CASCADE`);

    // ── Sections (4) ──────────────────────────────────────────────────────
    const sections = {};
    for (const [name, order] of [
      ['Main Store / Backroom', 1],
      ['Base Kitchen', 2],
      ['Bar & Liquor', 3],
      ['Outlet & Consumables', 4],
    ]) {
      const { rows } = await c.query(
        'INSERT INTO sections (name, sort_order) VALUES ($1,$2) RETURNING id', [name, order]);
      sections[name] = rows[0].id;
    }

    // ── Categories (~8) ───────────────────────────────────────────────────
    const catDefs = [
      ['Dry Store', 'Main Store / Backroom'],
      ['Frozen & Chilled', 'Main Store / Backroom'],
      ['Vegetables & Dairy', 'Base Kitchen'],
      ['Sauces & Condiments', 'Base Kitchen'],
      ['Spirits', 'Bar & Liquor'],
      ['Beer & Wine', 'Bar & Liquor'],
      ['Crockery & Cutlery', 'Outlet & Consumables'],
      ['Packaging & Consumables', 'Outlet & Consumables'],
    ];
    const cats = {};
    for (const [name, section] of catDefs) {
      const { rows } = await c.query(
        'INSERT INTO categories (name, section_id) VALUES ($1,$2) RETURNING id',
        [name, sections[section]]);
      cats[name] = rows[0].id;
    }

    // ── Stores (2) ────────────────────────────────────────────────────────
    const storeIds = {};
    for (const [code, name, address] of [
      ['AERO', 'Aerocity Outlet', 'Aerocity, New Delhi'],
      ['CP', 'Connaught Place Outlet', 'CP Block A, New Delhi'],
    ]) {
      const { rows } = await c.query(
        'INSERT INTO stores (code, name, address) VALUES ($1,$2,$3) RETURNING id',
        [code, name, address]);
      storeIds[code] = rows[0].id;
    }

    // ── Users (3) ─────────────────────────────────────────────────────────
    const creds = [
      { username: 'admin', name: 'Admin (Audix)', role: 'admin', password: 'admin123', stores: [] },
      { username: 'rakesh', name: 'Rakesh Kumar', role: 'auditor', password: 'rakesh123', stores: ['AERO', 'CP'] },
      { username: 'sunil', name: 'Sunil Verma', role: 'auditor', password: 'sunil123', stores: ['AERO'] },
    ];
    const userIds = {};
    for (const u of creds) {
      const hash = await hashPassword(u.password);
      const { rows } = await c.query(
        'INSERT INTO users (username, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [u.username, u.name, hash, u.role]);
      userIds[u.username] = rows[0].id;
      for (const s of u.stores) {
        await c.query('INSERT INTO user_stores (user_id, store_id) VALUES ($1,$2)',
          [rows[0].id, storeIds[s]]);
      }
    }

    // ── Items (30: 22 regular + 8 liquor) ─────────────────────────────────
    const items = [
      // code, name, category, unit, rate
      ['DRY-001', 'Refined Oil', 'Dry Store', 'Ltr', 140],
      ['DRY-002', 'Basmati Rice', 'Dry Store', 'Kg', 95],
      ['DRY-003', 'Wheat Flour (Atta)', 'Dry Store', 'Kg', 42],
      ['DRY-004', 'Sugar', 'Dry Store', 'Kg', 45],
      ['DRY-005', 'Salt', 'Dry Store', 'Kg', 20],
      ['DRY-006', 'Toor Dal', 'Dry Store', 'Kg', 130],
      ['FRZ-001', 'Chicken Breast (Frozen)', 'Frozen & Chilled', 'Kg', 260],
      ['FRZ-002', 'French Fries (Frozen)', 'Frozen & Chilled', 'Kg', 120],
      ['FRZ-003', 'Prawns (Frozen)', 'Frozen & Chilled', 'Kg', 520],
      ['VEG-001', 'Tomato', 'Vegetables & Dairy', 'Kg', 40],
      ['VEG-002', 'Onion', 'Vegetables & Dairy', 'Kg', 35],
      ['VEG-003', 'Paneer', 'Vegetables & Dairy', 'Kg', 320],
      ['VEG-004', 'Butter', 'Vegetables & Dairy', 'Kg', 480],
      ['SAU-001', 'Soy Sauce', 'Sauces & Condiments', 'Ltr', 180],
      ['SAU-002', 'Tomato Ketchup', 'Sauces & Condiments', 'Kg', 110],
      ['SAU-003', 'Mayonnaise', 'Sauces & Condiments', 'Kg', 150],
      ['CRK-001', 'Dinner Plate', 'Crockery & Cutlery', 'Nos', 220],
      ['CRK-002', 'Water Glass', 'Crockery & Cutlery', 'Nos', 60],
      ['CRK-003', 'Fork', 'Crockery & Cutlery', 'Nos', 45],
      ['CRK-004', 'Wine Glass', 'Crockery & Cutlery', 'Nos', 130],
      ['PKG-001', 'Takeaway Box (Large)', 'Packaging & Consumables', 'Nos', 8],
      ['PKG-002', 'Paper Napkin (Pack)', 'Packaging & Consumables', 'Pack', 35],
    ];
    // 8 liquor
    const liquor = [
      // code, name, category, bottle_size_ml, rate
      ['LIQ-001', 'Old Monk Rum', 'Spirits', 750, 750],
      ['LIQ-002', 'Blenders Pride Whisky', 'Spirits', 750, 1050],
      ['LIQ-003', 'Smirnoff Vodka', 'Spirits', 750, 980],
      ['LIQ-004', 'Bacardi White Rum', 'Spirits', 750, 1150],
      ['LIQ-005', 'Beefeater Gin', 'Spirits', 750, 2400],
      ['LIQ-006', 'Jameson Whiskey', 'Spirits', 1000, 3200],
      ['LIQ-007', 'Kingfisher Premium Beer', 'Beer & Wine', 650, 160],
      ['LIQ-008', 'Sula Sauvignon Blanc', 'Beer & Wine', 750, 950],
    ];

    const itemIds = {};
    for (const [code, name, cat, unit, rate] of items) {
      const catId = cats[cat];
      const secId = (await c.query('SELECT section_id FROM categories WHERE id=$1', [catId])).rows[0].section_id;
      const { rows } = await c.query(
        `INSERT INTO items (code, name, category_id, section_id, unit, is_liquor, rate)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6) RETURNING id`,
        [code, name, catId, secId, unit, rate]);
      itemIds[code] = rows[0].id;
    }
    for (const [code, name, cat, ml, rate] of liquor) {
      const catId = cats[cat];
      const secId = (await c.query('SELECT section_id FROM categories WHERE id=$1', [catId])).rows[0].section_id;
      const { rows } = await c.query(
        `INSERT INTO items (code, name, category_id, section_id, unit, is_liquor, bottle_size_ml, rate)
         VALUES ($1,$2,$3,$4,'Bottle',TRUE,$5,$6) RETURNING id`,
        [code, name, catId, secId, ml, rate]);
      itemIds[code] = rows[0].id;
    }

    // ── One open audit for Aerocity ───────────────────────────────────────
    const { rows: auditRows } = await c.query(
      `INSERT INTO audits (store_id, audit_date, cutoff_time, status, created_by)
       VALUES ($1, CURRENT_DATE, '6:00 PM', 'open', $2) RETURNING id`,
      [storeIds['AERO'], userIds['admin']]);
    const auditId = auditRows[0].id;

    const rakesh = userIds['rakesh'];
    const sunil = userIds['sunil'];

    // Sample entries — including an item counted at TWO locations (append-only)
    // and one VOIDED entry, so the behaviour is visible immediately.
    const mkEntry = (itemCode, fields) => c.query(
      `INSERT INTO count_entries (audit_id, item_id, qty, bottles, open_ml, location_text, remarks, counted_by, status, void_reason, voided_by, voided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [auditId, itemIds[itemCode], fields.qty ?? null, fields.bottles ?? null, fields.open_ml ?? null,
       fields.location ?? null, fields.remarks ?? null, fields.by ?? rakesh,
       fields.status ?? 'active', fields.void_reason ?? null,
       fields.voided_by ?? null, fields.voided_at ?? null]);

    // Refined Oil — TWO entries, different locations (append-only demo)
    await mkEntry('DRY-001', { qty: 1.0, location: 'Dry Store', by: rakesh });
    await mkEntry('DRY-001', { qty: 2.0, location: 'Basement rack', by: rakesh });

    // A voided entry (wrong count) — kept, struck through, excluded from totals
    await mkEntry('DRY-002', { qty: 99, location: 'Dry Store', by: rakesh,
      status: 'void', void_reason: 'Miscounted sacks — re-counted below',
      voided_by: rakesh, voided_at: new Date().toISOString() });
    await mkEntry('DRY-002', { qty: 40, location: 'Dry Store', by: rakesh });

    // A few more regular counts
    await mkEntry('DRY-004', { qty: 25, location: 'Dry Store', by: sunil });
    await mkEntry('VEG-003', { qty: 8.5, location: 'Cold room', by: sunil });
    await mkEntry('CRK-001', { qty: 120, location: 'Wash area', by: sunil });
    // Zero-quantity explicit count (counted, found zero)
    await mkEntry('FRZ-003', { qty: 0, location: 'Freezer 2', remarks: 'Out of stock', by: rakesh });

    // Liquor entries — bottles and open ml kept separate
    await mkEntry('LIQ-001', { bottles: 3, open_ml: 400, location: 'Bar shelf', by: rakesh });
    await mkEntry('LIQ-002', { bottles: 5, open_ml: 0, location: 'Bar store', by: rakesh });
    await mkEntry('LIQ-007', { bottles: 24, open_ml: 0, location: 'Beer chiller', by: sunil });

    // System stock for a handful of items (for variance demo)
    const sysStock = [['DRY-001', 3], ['DRY-002', 42], ['DRY-004', 25], ['FRZ-003', 2],
      ['LIQ-001', 3], ['LIQ-002', 6], ['LIQ-007', 24], ['VEG-003', 9]];
    for (const [code, qty] of sysStock) {
      await c.query(
        'INSERT INTO system_stock (audit_id, item_id, qty, created_by) VALUES ($1,$2,$3,$4)',
        [auditId, itemIds[code], qty, userIds['admin']]);
    }
  });

  console.log('\n════════════════════════════════════════════');
  console.log(' Seed complete. Login credentials:');
  console.log('════════════════════════════════════════════');
  console.log(' ADMIN    username: admin    password: admin123');
  console.log(' AUDITOR  username: rakesh   password: rakesh123  (Aerocity + CP)');
  console.log(' AUDITOR  username: sunil    password: sunil123   (Aerocity)');
  console.log('════════════════════════════════════════════\n');
  await pool.end();
}

seed().catch((err) => { console.error(err); process.exit(1); });
