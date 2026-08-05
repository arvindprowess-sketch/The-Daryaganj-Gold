import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { config, rootDir, assertProductionConfig } from './config.js';
import { enableAsyncRouteSafety } from './lib/asyncRoutes.js';

// Before anything else. In production an insecure configuration — the public
// development JWT secret, the default database URL, a wildcard CORS origin —
// exits the process here rather than serving a single request.
assertProductionConfig();

// Must run BEFORE the route modules are imported, so their handlers are
// registered through the patched Router. Without this an async handler that
// rejects (e.g. a bad :itemId reaching Postgres) would crash the process.
enableAsyncRouteSafety();

import authRoutes from './routes/auth.js';
import storeRoutes from './routes/stores.js';
import userRoutes from './routes/users.js';
import metaRoutes from './routes/meta.js';
import itemRoutes from './routes/items.js';
import auditRoutes from './routes/audits.js';
import entryRoutes from './routes/entries.js';
import systemStockRoutes from './routes/systemStock.js';
import settingsRoutes from './routes/settings.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';
import uploadRoutes from './routes/uploads.js';
import photoReviewRoutes from './routes/photoReviews.js';
import dataManagementRoutes from './routes/dataManagement.js';

const app = express();

// Behind a reverse proxy (Render, Fly, nginx, Cloudflare) req.ip must come
// from X-Forwarded-For, or every request looks like it originates at the proxy
// and the login rate limiter would throttle the whole firm as one client.
// One hop only — trusting the whole chain would let a client spoof its own IP
// and walk straight past the limiter.
if (config.nodeEnv === 'production') app.set('trust proxy', 1);

// Security headers. Defaults, with one deliberate adjustment: photos are
// served from the object-storage host (Cloudflare R2 / S3), which the default
// img-src 'self' would block. The host is allow-listed rather than turning the
// policy off.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'img-src': ["'self'", 'data:', 'blob:', ...photoHosts()] },
  },
  // Photos are fetched cross-origin from the storage host by the browser.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// The hosts photos may be loaded from: the public bucket URL, and the S3
// endpoint itself when no separate public URL is configured.
function photoHosts() {
  const hosts = new Set();
  for (const url of [config.s3.publicBaseUrl, config.s3.endpoint]) {
    if (!url) continue;
    try { hosts.add(new URL(url).origin); } catch { /* not a URL — ignore */ }
  }
  return [...hosts];
}

app.use(cors({
  // '*' is refused outright in production by assertProductionConfig(); in
  // development it stays available for testing from a device on the LAN.
  origin: config.clientOrigin === '*' ? true : config.clientOrigin.split(','),
}));
app.use(express.json({ limit: '2mb' }));

// Serve locally-stored uploads in dev (S3/R2 serves its own URLs in prod).
app.use('/uploads', express.static(path.join(rootDir, config.uploadDir)));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/audits', auditRoutes);
app.use('/api', entryRoutes); // /api/audits/:id/entries, /api/entries/:id/void, /api/audits/:id/na
app.use('/api/system-stock', systemStockRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/data', dataManagementRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/photo-reviews', photoReviewRoutes);

// Central error handler
app.use((err, _req, res, _next) => {
  // A rejected CSV is a normal outcome the admin has to act on, not a fault —
  // it carries its own explanation and does not belong in the error log.
  if (err.name !== 'CsvFormatError') console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: err.message || 'Server error',
    ...(err.code ? { code: err.code } : {}),
  });
});

// Demo data must never survive into a live environment. Warn loudly at
// startup if any is present — prominently in production.
async function warnAboutDemoData() {
  try {
    const { demoCounts } = await import('./routes/dataManagement.js');
    const d = await demoCounts();
    if (!d.present) return;
    const prod = config.nodeEnv === 'production';
    const line = '='.repeat(64);
    const say = prod ? console.error : console.warn;
    say('\n' + line);
    say(prod ? ' ⛔  DEMO DATA PRESENT IN PRODUCTION' : ' ⚠  Demo data present');
    say(line);
    say(` users ${d.users} · stores ${d.stores} · items ${d.items} · audits ${d.audits} · entries ${d.entries}`);
    if (prod) {
      say(' Demo accounts use passwords printed to a console during seeding.');
      say(' Remove this data before going live: Admin → Data management →');
      say(' "Delete demo data", or check Admin → System Readiness.');
    }
    say(line + '\n');
  } catch (err) {
    // A missing migration must not stop the server from starting.
    console.warn(`Demo-data check skipped: ${err.message}`);
  }
}

app.listen(config.port, () => {
  console.log(`Audix API listening on http://localhost:${config.port}`);
  console.log(`Storage driver: ${config.storageDriver}`);
  console.log(`Environment: ${config.nodeEnv}`);
  warnAboutDemoData();
});
