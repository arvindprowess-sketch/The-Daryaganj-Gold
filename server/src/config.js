import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load server/.env regardless of cwd
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Insecure development defaults ──────────────────────────────────────────
// These exist so `npm run dev` works with no setup. Every one of them is
// PUBLIC — this file is in the repository — so production must never run on
// them. See assertProductionConfig() below, which refuses to start if it does.
export const DEV_JWT_SECRET = 'dev-insecure-secret-change-me';
export const DEV_DATABASE_URL = 'postgres://audix:audix@localhost:5432/audix';
const MIN_JWT_SECRET_LENGTH = 32;

// Published placeholders. `.env.example` ships
// JWT_SECRET=change-me-to-a-long-random-string, which is 33 characters and so
// would pass a pure length test — copying the example file into production
// must not be a way through this check.
const PLACEHOLDER_SECRET = /change[-_ ]?me|changeme|your[-_ ]?secret|insecure|placeholder|example|secret[-_ ]?here|xxxx/i;

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || DEV_DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  // Short-lived access token, silently refreshed by the client so an active
  // auditor is never logged out mid-count.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  storageDriver: process.env.STORAGE_DRIVER || 'local',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  // S3-compatible object storage (Cloudflare R2, AWS S3, MinIO…). Swapping
  // provider is an env-var change only — no code change.
  // The documented names are S3_ACCESS_KEY / S3_SECRET_KEY / S3_PUBLIC_URL;
  // the longer AWS-style names are still accepted for backward compatibility.
  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY || process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_KEY || process.env.S3_SECRET_ACCESS_KEY || '',
    publicBaseUrl: process.env.S3_PUBLIC_URL || process.env.S3_PUBLIC_BASE_URL || '',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Production configuration checks.
//
// Each returns the same shape the System Readiness screen renders, so the
// startup guard and the checklist can never disagree about what is wrong.
// `fatal` means the server refuses to start in production.
// ═══════════════════════════════════════════════════════════════════════════
export function productionConfigChecks(env = config.nodeEnv) {
  const prod = env === 'production';
  const secret = process.env.JWT_SECRET || '';
  const dbUrl = process.env.DATABASE_URL || '';
  const origin = config.clientOrigin;

  // ── JWT_SECRET ───────────────────────────────────────────────────────────
  // The fallback is published in this repository. Anyone can mint a valid
  // admin token against a deploy that runs on it.
  let jwt;
  if (!secret) {
    jwt = { ok: false, detail: 'JWT_SECRET is not set — the server is using the public development fallback from config.js.' };
  } else if (secret === DEV_JWT_SECRET) {
    jwt = { ok: false, detail: 'JWT_SECRET is the development fallback, which is public in this repository.' };
  } else if (secret.length < MIN_JWT_SECRET_LENGTH) {
    jwt = { ok: false, detail: `JWT_SECRET is ${secret.length} characters — at least ${MIN_JWT_SECRET_LENGTH} are required.` };
  } else if (PLACEHOLDER_SECRET.test(secret)) {
    jwt = { ok: false, detail: 'JWT_SECRET still looks like the placeholder from .env.example. Generate a real random value.' };
  } else {
    jwt = { ok: true, detail: `Set, ${secret.length} characters.` };
  }

  // ── DATABASE_URL ─────────────────────────────────────────────────────────
  // The default carries the credentials audix/audix and points at localhost.
  let db;
  if (!dbUrl) {
    db = { ok: false, detail: 'DATABASE_URL is not set — the server is using the development localhost default.' };
  } else if (dbUrl === DEV_DATABASE_URL) {
    db = { ok: false, detail: 'DATABASE_URL is the development default (audix/audix on localhost).' };
  } else {
    db = { ok: true, detail: `Set (${redactDbUrl(dbUrl)}).` };
  }

  // ── CLIENT_ORIGIN ────────────────────────────────────────────────────────
  // '*' reflects whatever Origin the browser sends, which defeats the point of
  // having CORS at all when requests carry a token.
  const cors = origin === '*'
    ? { ok: false, detail: "CLIENT_ORIGIN is '*', which reflects any origin. Set an explicit comma-separated list." }
    : { ok: true, detail: `Allowed origin(s): ${origin}` };

  return [
    { key: 'jwt_secret', label: 'JWT_SECRET is set and strong', ...jwt },
    { key: 'database_url', label: 'DATABASE_URL is not the development default', ...db },
    { key: 'client_origin', label: 'CORS origin is explicit, not a wildcard', ...cors },
  ].map((c) => ({
    ...c,
    // In production a failure here stops the server booting. Outside it, the
    // dev defaults are the expected state, so the readiness screen shows the
    // row as something to fix before deploying, not as a fault right now.
    blocking: prod && !c.ok,
    advisory: !prod,
  }));
}

// Never print a password into a log or an admin screen.
function redactDbUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${u.username}:***@` : ''}${u.host}${u.pathname}`;
  } catch {
    return 'unparseable URL';
  }
}

// Called before anything listens. In production a failure is FATAL: the
// process exits rather than serving traffic on a known-compromisable config.
// Outside production the same problems are printed as warnings only.
export function assertProductionConfig({ exit = true } = {}) {
  const checks = productionConfigChecks();
  const failures = checks.filter((c) => !c.ok);
  if (failures.length === 0) return checks;

  const prod = config.nodeEnv === 'production';
  const line = '='.repeat(64);
  const say = prod ? console.error : console.warn;
  say('\n' + line);
  say(prod ? ' ⛔  REFUSING TO START — INSECURE PRODUCTION CONFIGURATION'
           : ' ⚠  Development configuration (would refuse to start in production)');
  say(line);
  for (const f of failures) say(` ✗ ${f.label}\n   ${f.detail}`);
  say(line);
  if (prod) {
    say(' Set these in the environment and restart. Generate a secret with:');
    say('   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    say(line + '\n');
    if (exit) process.exit(1);
  } else {
    say('\n');
  }
  return checks;
}

export const rootDir = path.join(__dirname, '..');
