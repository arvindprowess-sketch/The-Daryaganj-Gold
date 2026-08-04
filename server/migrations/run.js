import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
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
      client.release();
    }
  }
  console.log('Migrations complete.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
