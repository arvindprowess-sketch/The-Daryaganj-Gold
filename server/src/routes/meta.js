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

// ── Store Room / Outlet zones ──────────────────────────────────────────────
// The audit report splits physical quantity into Store Room and Outlet
// columns, but auditors type the location as free text. This is where an admin
// assigns each name they actually use to one side.
//
// `unmapped` lists the location names already recorded on count entries that
// have no assignment yet, so existing data can be mapped correctly rather than
// silently landing on the default.
router.get('/location-zones', requireRole('admin'), async (_req, res) => {
  const { rows: zones } = await query(
    'SELECT id, name, zone FROM location_zones ORDER BY zone, lower(name)');
  const { rows: unmapped } = await query(
    `SELECT btrim(ce.location_text) AS name, count(*)::int AS entries
       FROM count_entries ce
       LEFT JOIN location_zones lz
              ON lower(btrim(lz.name)) = lower(btrim(ce.location_text))
      WHERE ce.status = 'active'
        AND COALESCE(btrim(ce.location_text), '') <> ''
        AND lz.id IS NULL
      GROUP BY btrim(ce.location_text)
      ORDER BY count(*) DESC`);
  const { rows: setting } = await query(
    `SELECT value FROM settings WHERE key = 'location_default_zone'`);
  // Entries with no location at all also fall to the default — worth stating.
  const { rows: blank } = await query(
    `SELECT count(*)::int AS n FROM count_entries
      WHERE status='active' AND COALESCE(btrim(location_text), '') = ''`);
  res.json({
    zones,
    unmapped,
    blank_location_entries: blank[0].n,
    default_zone: setting[0]?.value === 'store_room' ? 'store_room' : 'outlet',
  });
});

router.post('/location-zones', requireRole('admin'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const zone = req.body?.zone;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!['store_room', 'outlet'].includes(zone)) {
    return res.status(400).json({ error: "zone must be 'store_room' or 'outlet'" });
  }
  try {
    const { rows } = await query(
      'INSERT INTO location_zones (name, zone) VALUES ($1,$2) RETURNING *', [name, zone]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `"${name}" is already assigned` });
    throw err;
  }
});

// Declared BEFORE /:id — otherwise Express matches 'default' as an id.
// Where an unmapped location is counted.
router.put('/location-zones/default', requireRole('admin'), async (req, res) => {
  const zone = req.body?.zone;
  if (!['store_room', 'outlet'].includes(zone)) {
    return res.status(400).json({ error: "zone must be 'store_room' or 'outlet'" });
  }
  await query(
    `INSERT INTO settings (key, value) VALUES ('location_default_zone', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [zone]);
  res.json({ ok: true, default_zone: zone });
});

router.put('/location-zones/:id', requireRole('admin'), async (req, res) => {
  const zone = req.body?.zone;
  if (!['store_room', 'outlet'].includes(zone)) {
    return res.status(400).json({ error: "zone must be 'store_room' or 'outlet'" });
  }
  const { rows } = await query(
    'UPDATE location_zones SET zone=$2 WHERE id=$1 RETURNING *', [req.params.id, zone]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.delete('/location-zones/:id', requireRole('admin'), async (req, res) => {
  const { rowCount } = await query('DELETE FROM location_zones WHERE id=$1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
