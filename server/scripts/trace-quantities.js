// ═══════════════════════════════════════════════════════════════════════════
// Answers ONE question: where did this quantity come from?
//
// When a report shows stock for an item nobody remembers counting, there are
// only ever three explanations, and this prints which one applies:
//
//   1. Somebody DID count it — a different auditor, or a second location
//   2. It is left-over TEST or DEMO data from before go-live
//   3. It belongs to a DIFFERENT audit than the one being looked at
//
// It also separates the two figures people mix up. "Physical" is what the
// auditor actually counted. "Final Total Qty" is that count multiplied by the
// item's Bottle/Unit Size, so 10 tins with a size of 2500 reads as 25,000 —
// correct, but it looks like a quantity nobody entered.
//
// READ ONLY. It writes nothing and is safe to run against production.
//
//   npm run trace -- --audit 1 --category PROVISION
//   npm run trace -- --audit 1                    # every category
//   npm run trace -- --audit 1 --all              # include uncounted items
// ═══════════════════════════════════════════════════════════════════════════
import { pool, query } from '../src/db.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

const auditId = Number(arg('audit') || 0);
const category = arg('category');
const showAll = has('all');

const num = (v) => Number(v ?? 0);
const fmt = (v) => (num(v) === 0 ? '·' : String(num(v)));

async function main() {
  if (!auditId) {
    console.error('Usage: npm run trace -- --audit <id> [--category NAME] [--all]');
    const { rows } = await query(
      `SELECT a.id, a.audit_date, a.status, s.name AS store,
              (SELECT count(*) FROM count_entries ce
                WHERE ce.audit_id = a.id AND ce.status='active')::int AS entries
         FROM audits a JOIN stores s ON s.id = a.store_id ORDER BY a.id`
    );
    console.error('\nAudits in this database:');
    for (const a of rows) {
      const date = a.audit_date instanceof Date
        ? a.audit_date.toISOString().slice(0, 10) : String(a.audit_date).slice(0, 10);
      console.error(`  --audit ${a.id}   ${a.store} · ${date} · ${a.status} · ${a.entries} active entries`);
    }
    process.exitCode = 1;
    return;
  }

  // Every active entry on this audit, with who put it there and whether it is
  // demo data. Nothing is aggregated away — a quantity you cannot explain is
  // explained by the row that produced it.
  const { rows } = await query(
    `SELECT c.name AS category, i.name AS item, i.unit, i.bottle_unit_size,
            ce.id AS entry_id, ce.qty, ce.bottles, ce.open_ml, ce.location_text,
            ce.counted_at, ce.is_demo, u.username AS counted_by, u.name AS counted_by_name,
            i.is_liquor
       FROM count_entries ce
       JOIN items i ON i.id = ce.item_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN users u ON u.id = ce.counted_by
      WHERE ce.audit_id = $1 AND ce.status = 'active'
        AND ($2::text IS NULL OR lower(c.name) = lower($2))
      ORDER BY c.name, i.name, ce.counted_at`,
    [auditId, category || null]
  );

  if (!rows.length) {
    console.log(category
      ? `No active count entries in "${category}" on audit ${auditId}.`
      : `No active count entries on audit ${auditId}.`);
    console.log('If a report still shows stock here, it is reading a different audit.');
    return;
  }

  const byItem = new Map();
  for (const r of rows) {
    const key = `${r.category || '—'} :: ${r.item}`;
    if (!byItem.has(key)) byItem.set(key, { ...r, entries: [] });
    byItem.get(key).entries.push(r);
  }

  let demoEntries = 0;
  const authors = new Map();

  for (const [key, it] of byItem) {
    const native = (e) => (it.is_liquor ? num(e.bottles) : num(e.qty));
    const counted = it.entries.reduce((s, e) => s + native(e), 0);
    const loose = it.entries.reduce((s, e) => s + num(e.open_ml), 0);
    const size = num(it.bottle_unit_size) || 1;
    const final = counted * size + loose;

    console.log(`\n${key}`);
    console.log(`  unit ${it.unit || '—'} · Bottle/Unit Size ${size}`);
    for (const e of it.entries) {
      if (e.is_demo) demoEntries++;
      authors.set(e.counted_by || '(deleted user)', (authors.get(e.counted_by || '(deleted user)') || 0) + 1);
      console.log(
        `  #${String(e.entry_id).padEnd(6)} ${fmt(native(e)).padStart(9)}`
        + `${it.is_liquor ? ' btl' : '    '} loose ${fmt(e.open_ml).padStart(6)}`
        + `  ${String(e.location_text || '(no location)').padEnd(18)}`
        + `  ${new Date(e.counted_at).toISOString().replace('T', ' ').slice(0, 16)}`
        + `  by ${e.counted_by || '?'}${e.is_demo ? '   ⚠ DEMO DATA' : ''}`
      );
    }
    // The line that usually settles the argument: what was counted, versus
    // what the report prints after the size multiplier.
    console.log(`  → physical counted ${counted}${loose ? ` + ${loose} loose` : ''}`
      + `   ·   Final Total Qty ${final}`
      + (size !== 1 ? `   (${counted} × ${size}${loose ? ` + ${loose}` : ''})` : ''));
  }

  if (showAll) {
    const { rows: ghosts } = await query(
      `SELECT c.name AS category, i.name AS item
         FROM items i LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.is_active
          AND ($2::text IS NULL OR lower(c.name) = lower($2))
          AND NOT EXISTS (SELECT 1 FROM count_entries ce
                           WHERE ce.item_id = i.id AND ce.audit_id = $1 AND ce.status='active')
        ORDER BY c.name, i.name`,
      [auditId, category || null]
    );
    console.log(`\n── Never counted on this audit: ${ghosts.length} item(s) ──`);
    for (const g of ghosts) console.log(`  ${g.category || '—'} :: ${g.item}`);
  }

  console.log('\n════ Summary ════');
  console.log(`Audit ${auditId}${category ? ` · category ${category}` : ''}`);
  console.log(`Items with stock : ${byItem.size}`);
  console.log(`Active entries   : ${rows.length}`);
  console.log(`Entered by       : ${[...authors].map(([u, n]) => `${u} (${n})`).join(', ')}`);
  if (demoEntries > 0) {
    console.log(`\n⚠  ${demoEntries} of these entries are DEMO DATA, not a real count.`);
    console.log('   Remove them from Admin → Settings → Delete demo data.');
  } else {
    console.log('\nNo demo data here — every entry above was saved through the app by the user named.');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
