import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, rootDir } from './config.js';
import { enableAsyncRouteSafety } from './lib/asyncRoutes.js';

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
app.use(cors({ origin: config.clientOrigin === '*' ? true : config.clientOrigin.split(',') }));
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
  console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
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
