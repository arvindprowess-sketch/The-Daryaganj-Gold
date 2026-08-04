import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Sections + categories are reference data readable by any authenticated user
// (auditors need them for the section list M4 and category chips M5). They
// carry no rate/value/system data, so they are safe under blind count.
router.get('/sections', async (_req, res) => {
  const { rows } = await query(
    'SELECT * FROM sections WHERE is_active = TRUE ORDER BY sort_order, name'
  );
  res.json(rows);
});

router.get('/categories', async (_req, res) => {
  const { rows } = await query(
    'SELECT * FROM categories WHERE is_active = TRUE ORDER BY name'
  );
  res.json(rows);
});

router.post('/sections', requireRole('admin'), async (req, res) => {
  const { name, sort_order = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    'INSERT INTO sections (name, sort_order) VALUES ($1, $2) RETURNING *',
    [name, sort_order]
  );
  res.status(201).json(rows[0]);
});

router.post('/categories', requireRole('admin'), async (req, res) => {
  const { name, section_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    'INSERT INTO categories (name, section_id) VALUES ($1, $2) RETURNING *',
    [name, section_id || null]
  );
  res.status(201).json(rows[0]);
});

export default router;
