import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// List stores. Auditors see only their assigned stores; admins see all.
router.get('/', async (req, res) => {
  if (req.user.role === 'admin') {
    const { rows } = await query('SELECT * FROM stores ORDER BY name');
    return res.json(rows);
  }
  const { rows } = await query(
    `SELECT s.* FROM stores s
       JOIN user_stores us ON us.store_id = s.id
      WHERE us.user_id = $1 AND s.is_active = TRUE
      ORDER BY s.name`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { code, name, address, is_active = true } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  try {
    const { rows } = await query(
      `INSERT INTO stores (code, name, address, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [code, name, address || null, is_active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Store code exists' });
    throw err;
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const { code, name, address, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE stores SET
       code = COALESCE($2, code),
       name = COALESCE($3, name),
       address = COALESCE($4, address),
       is_active = COALESCE($5, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, code, name, address, is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

export default router;
