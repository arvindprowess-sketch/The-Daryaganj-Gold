import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This runs on every start, so two instances deploying at once would both see
// a migration as unapplied and both try to run it — one would commit and the
// other would die on the primary key. A session-level advisory lock serialises
// them: the second waits, then finds everything applied and skips. The number
// is arbitrary but must never change.
const LOCK_ID = 8274301;

async function run() {
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await migrate();
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    lock.release();
  }
  await pool.end();
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (rowCount > 0) {
      console.log(`↷ skip   ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const client = await pool.connect();
    // A migration that reports what it is about to change is useless if the
    // report never reaches the operator. node-postgres swallows NOTICE unless
    // something listens, and these run on deploy where the log is the only
    // place anyone will see them.
    const onNotice = (msg) => {
      if (msg?.message) console.log(`   │ ${msg.message}`);
    };
    client.on('notice', onNotice);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
        file,
      ]);
      await client.query('COMMIT');
      console.log(`✓ apply  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ failed ${file}`);
      throw err;
    } finally {
      client.removeListener('notice', onNotice);
      client.release();
    }
  }
  console.log('Migrations complete.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
