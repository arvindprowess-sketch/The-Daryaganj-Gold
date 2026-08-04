import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { hashPassword } from '../lib/auth.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// List users with their store mappings.
router.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.name, u.role, u.is_active, u.created_at,
            COALESCE(
              (SELECT json_agg(us.store_id) FROM user_stores us WHERE us.user_id = u.id),
              '[]'
            ) AS store_ids
       FROM users u
       ORDER BY u.role, u.name`
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { username, name, password, role, store_ids = [], is_active = true } =
    req.body || {};
  if (!username || !name || !password || !role) {
    return res.status(400).json({ error: 'username, name, password, role required' });
  }
  if (!['admin', 'auditor'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const hash = await hashPassword(password);
  try {
    const user = await withTransaction(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (username, name, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, name, role, is_active, created_at`,
        [username, name, hash, role, is_active]
      );
      const u = rows[0];
      for (const sid of store_ids) {
        await c.query(
          'INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [u.id, sid]
        );
      }
      return u;
    });
    res.status(201).json({ ...user, store_ids });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username exists' });
    throw err;
  }
});

router.put('/:id', async (req, res) => {
  const { name, role, password, is_active, store_ids } = req.body || {};
  const passwordHash = password ? await hashPassword(password) : null;
  const updated = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         role = COALESCE($3, role),
         is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash)
       WHERE id = $1
       RETURNING id, username, name, role, is_active, created_at`,
      [req.params.id, name, role, is_active, passwordHash]
    );
    const u = rows[0];
    if (!u) return null;
    if (Array.isArray(store_ids)) {
      await c.query('DELETE FROM user_stores WHERE user_id = $1', [u.id]);
      for (const sid of store_ids) {
        await c.query(
          'INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [u.id, sid]
        );
      }
    }
    return u;
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

export default router;
