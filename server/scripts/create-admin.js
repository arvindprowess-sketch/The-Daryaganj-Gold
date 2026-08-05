// ═══════════════════════════════════════════════════════════════════════════
// Creates the FIRST REAL admin account for a production deployment.
//
// A production database is seeded with `npm run seed` (hierarchy only), which
// deliberately creates no users — so this is how the first login is made.
// The account is NOT demo data: is_demo = false, and it never appears in the
// demo banner or in "delete demo data".
//
//   npm run create:admin -- --username arvind --name "Arvind" --password '...'
//
// If --password is omitted a strong one is generated and printed once.
// ═══════════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import { pool, query } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const username = (arg('username') || '').trim();
  const name = (arg('name') || username).trim();
  let password = arg('password');
  const generated = !password;
  if (generated) password = crypto.randomBytes(12).toString('base64url');

  if (!username) {
    console.error('Usage: npm run create:admin -- --username <u> [--name "<n>"] [--password <p>]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const { rows: existing } = await query(
    'SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (existing[0]) {
    console.error(`A user named "${username}" already exists.`);
    process.exit(1);
  }

  const { rows } = await query(
    `INSERT INTO users (username, name, password_hash, role, is_demo, must_change_password)
     VALUES ($1, $2, $3, 'admin', FALSE, $4)
     RETURNING id, username, name, role`,
    // A password supplied on the command line ends up in shell history, so it
    // must be changed at first login. A generated one shown once does not.
    [username, name, await hashPassword(password), !generated]
  );

  console.log('\n════════════════════════════════════════════');
  console.log(' Admin created (real account, not demo data).');
  console.log('════════════════════════════════════════════');
  console.log(` username : ${rows[0].username}`);
  console.log(` name     : ${rows[0].name}`);
  if (generated) {
    console.log(` password : ${password}`);
    console.log('  ↑ shown once — store it now.');
  } else {
    console.log(' password : as supplied (must be changed at first login,');
    console.log('            because it was typed on the command line)');
  }
  console.log('════════════════════════════════════════════\n');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
