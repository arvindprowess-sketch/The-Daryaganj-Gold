import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, rootDir } from './config.js';

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
app.use('/api/upload', uploadRoutes);

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(config.port, () => {
  console.log(`Audix API listening on http://localhost:${config.port}`);
  console.log(`Storage driver: ${config.storageDriver}`);
});
