// ═══════════════════════════════════════════════════════════════════════════
// Production guard for seed scripts.
//
// The demo seed creates users whose passwords are printed to the console.
// None of that may ever exist in a live environment, so a seed refuses to run
// under NODE_ENV=production unless `--force-seed` is passed explicitly.
// It refuses outright — no prompt, no partial run.
// ═══════════════════════════════════════════════════════════════════════════
import { config } from '../src/config.js';

export function assertSeedAllowed(scriptName, { allowInProduction = false } = {}) {
  const isProd = config.nodeEnv === 'production';
  if (!isProd) return;

  if (allowInProduction) {
    console.log(`NODE_ENV=production — running ${scriptName} (reference data only).`);
    return;
  }

  const forced = process.argv.includes('--force-seed');
  if (!forced) {
    console.error('');
    console.error('════════════════════════════════════════════════════════════');
    console.error(` REFUSING TO RUN ${scriptName} — NODE_ENV=production`);
    console.error('════════════════════════════════════════════════════════════');
    console.error(' This script creates demo users with console-printed');
    console.error(' passwords, plus sample stores, items, audits and entries.');
    console.error(' None of that may exist in a live environment.');
    console.error('');
    console.error(' If seeding production is genuinely intended, re-run with:');
    console.error(`   npm run ${scriptName} -- --force-seed`);
    console.error('════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  console.warn('');
  console.warn('⚠  --force-seed given: seeding DEMO DATA into a PRODUCTION environment.');
  console.warn('⚠  Demo accounts will be created and must be removed before go-live.');
  console.warn('');
}
