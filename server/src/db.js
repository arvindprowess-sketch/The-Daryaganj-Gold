import pg from 'pg';
import { config } from './config.js';

// Numeric (NUMERIC/DECIMAL) columns come back as strings from node-postgres by
// default to avoid float precision loss. We parse them to Number for the API
// since audit quantities fit comfortably in a JS double at the precisions used.
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
