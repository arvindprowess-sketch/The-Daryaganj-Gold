import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ═══════════════════════════════════════════════════════════════════════════
// Hierarchy reference data: super_categories → categories → items.
// BOTH levels are admin-manageable rows, not hardcoded constants — the client
// can add a super category or a category at any time.
//
// Readable by any authenticated user (auditors need super categories for M4).
// They carry no rate/value/system data, so they are safe under blind count.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/super-categories', async (_req, res) => {
  const { rows } = await query(
    'SELECT * FROM super_categories WHERE is_active = TRUE ORDER BY sort_order, name'
  );
  res.json(rows);
});

router.get('/categories', async (req, res) => {
  const params = [];
  let where = 'WHERE c.is_active = TRUE';
  if (req.query.super_category_id) {
    params.push(req.query.super_category_id);
    where += ` AND c.super_category_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT c.*, sc.name AS super_category_name
       FROM categories c
       LEFT JOIN super_categories sc ON sc.id = c.super_category_id
       ${where}
       ORDER BY sc.sort_order NULLS LAST, sc.name, c.name`,
    params
  );
  res.json(rows);
});

// ── Admin management ────────────────────────────────────────────────────────
router.post('/super-categories', requireRole('admin'), async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      'INSERT INTO super_categories (name, sort_order) VALUES ($1,$2) RETURNING *',
      [name, req.body?.sort_order ?? 99]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Super category already exists' });
    throw err;
  }
});

router.put('/super-categories/:id', requireRole('admin'), async (req, res) => {
  const { name, sort_order, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE super_categories SET
       name = COALESCE($2, name),
       sort_order = COALESCE($3, sort_order),
       is_active = COALESCE($4, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name ? name.trim() : null, sort_order, is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.post('/categories', requireRole('admin'), async (req, res) => {
  const name = (req.body?.name || '').trim();
  const superId = req.body?.super_category_id || null;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      'INSERT INTO categories (name, super_category_id) VALUES ($1,$2) RETURNING *',
      [name, superId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Category already exists in that super category' });
    throw err;
  }
});

router.put('/categories/:id', requireRole('admin'), async (req, res) => {
  const { name, super_category_id, is_active } = req.body || {};
  const { rows } = await query(
    `UPDATE categories SET
       name = COALESCE($2, name),
       super_category_id = COALESCE($3, super_category_id),
       is_active = COALESCE($4, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name ? name.trim() : null, super_category_id, is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

export default router;
