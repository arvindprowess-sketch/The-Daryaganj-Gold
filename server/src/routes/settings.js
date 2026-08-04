import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', async (_req, res) => {
  const { rows } = await query('SELECT key, value FROM settings ORDER BY key');
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

router.put('/', async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, String(value)]
    );
  }
  const { rows } = await query('SELECT key, value FROM settings ORDER BY key');
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

export default router;
