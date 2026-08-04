// ═══════════════════════════════════════════════════════════════════════════
// One-time migration: move any photo held IN the database out to object
// storage, replacing the column value with the public URL.
//
// Photos must never be stored as binary or base64 in Postgres. This script is
// idempotent and safe to re-run: rows that already hold a plain URL are left
// alone. It handles two legacy shapes:
//
//   1. a `data:image/...;base64,...` URI sitting in photo_url
//   2. a bare base64 blob in photo_url (no data: prefix)
//
// Usage:  node scripts/migrate-photos-to-storage.js [--dry-run]
//
// Run it AFTER setting STORAGE_DRIVER (and the S3_* variables when using R2/S3)
// so the files land in the destination you actually want.
// ═══════════════════════════════════════════════════════════════════════════
import sharp from 'sharp';
import { pool, query } from '../src/db.js';
import { storage } from '../src/lib/storage.js';
import { config } from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');

// A value we should migrate: base64 payload rather than an http(s) URL.
function isEmbedded(value) {
  if (!value || typeof value !== 'string') return false;
  if (/^https?:\/\//i.test(value)) return false;   // already a URL
  if (value.startsWith('/uploads/')) return false; // already a stored path
  return /^data:image\//i.test(value) || /^[A-Za-z0-9+/=\s]{256,}$/.test(value);
}

function toBuffer(value) {
  const base64 = value.startsWith('data:')
    ? value.slice(value.indexOf(',') + 1)
    : value;
  return Buffer.from(base64.replace(/\s+/g, ''), 'base64');
}

// Re-compress on the way out so migrated photos match the 1200px rule.
async function normalise(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

async function migrateTable({ table, idCol, urlCol, nameSql, versionCol }) {
  const { rows } = await query(
    `SELECT t.${idCol} AS id, t.${urlCol} AS url, ${nameSql} AS name FROM ${table} t
      WHERE t.${urlCol} IS NOT NULL`
  );
  let moved = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    if (!isEmbedded(row.url)) { skipped++; continue; }
    if (DRY_RUN) {
      console.log(`  would move ${table}#${row.id} (${row.name}) — ${row.url.length} chars`);
      moved++;
      continue;
    }
    try {
      const buf = await normalise(toBuffer(row.url));
      const { url } = await storage.save(buf, {
        ext: '.jpg', contentType: 'image/jpeg', name: row.name,
      });
      const bump = versionCol ? `, ${versionCol} = ${versionCol} + 1` : '';
      await query(`UPDATE ${table} SET ${urlCol} = $2${bump} WHERE ${idCol} = $1`, [row.id, url]);
      console.log(`  ✓ ${table}#${row.id} (${row.name}) → ${url}`);
      moved++;
    } catch (err) {
      console.error(`  ✗ ${table}#${row.id} (${row.name}): ${err.message}`);
      failed++;
    }
  }
  return { moved, skipped, failed, total: rows.length };
}

async function main() {
  console.log(`Storage driver: ${config.storageDriver}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  console.log('\nitems.photo_url (master photos)');
  const items = await migrateTable({
    table: 'items', idCol: 'id', urlCol: 'photo_url',
    nameSql: 't.name', versionCol: 'photo_version',
  });
  console.log(`  moved ${items.moved}, already-URL ${items.skipped}, failed ${items.failed}`);

  // Entry photos are evidence — they are migrated in place, never dropped.
  console.log('\ncount_entries.photo_url (entry evidence photos)');
  const entries = await migrateTable({
    table: 'count_entries', idCol: 'id', urlCol: 'photo_url',
    nameSql: '(SELECT i.name FROM items i WHERE i.id = t.item_id)',
  });
  console.log(`  moved ${entries.moved}, already-URL ${entries.skipped}, failed ${entries.failed}`);

  // photo_reviews holds proposed replacements awaiting admin approval.
  const { rows: hasReviews } = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'photo_reviews'`
  );
  if (hasReviews.length) {
    console.log('\nphoto_reviews.proposed_url (pending approvals)');
    const reviews = await migrateTable({
      table: 'photo_reviews', idCol: 'id', urlCol: 'proposed_url',
      nameSql: '(SELECT i.name FROM items i WHERE i.id = t.item_id)',
    });
    console.log(`  moved ${reviews.moved}, already-URL ${reviews.skipped}, failed ${reviews.failed}`);
  }

  const failed = items.failed + entries.failed;
  console.log(`\n${DRY_RUN ? 'Dry run complete.' : 'Migration complete.'}`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
