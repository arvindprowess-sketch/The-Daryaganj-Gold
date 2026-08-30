import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { logActivity } from '../lib/activityLog.js';
import { allLocations, activeLocations } from '../lib/locations.js';

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

// ── Locations ──────────────────────────────────────────────────────────────
// ONE GLOBAL LIST for every store. The report reads its columns from here, so
// this screen is what decides what the report looks like — renaming a place
// renames a column, reordering reorders them, and adding one adds a column.
//
// Superseded the old store_room / outlet zone mapping: a per-location column
// says everything the two-way split did and more, from a value the auditor
// picks rather than a word they type.
router.get('/locations', async (_req, res) => {
  res.json(await allLocations());
});

// What the entry screen offers. Auditors need this, so it is not admin-only.
router.get('/locations/active', async (_req, res) => {
  res.json(await activeLocations());
});

router.post('/locations', requireRole('admin'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const sort = Number.isFinite(Number(req.body?.sort_order))
    ? Number(req.body.sort_order) : null;
  try {
    const { rows } = await query(
      `INSERT INTO locations (name, sort_order)
       VALUES ($1, COALESCE($2, (SELECT COALESCE(MAX(sort_order),0) + 1 FROM locations)))
       RETURNING *`, [name, sort]);
    await logActivity({ entityType: 'location', entityId: rows[0].id, action: 'create',
      detail: { name }, userId: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `"${name}" already exists` });
    throw err;
  }
});

// Rename / reorder / deactivate. A rename carries every past entry with it,
// because entries point at the ID — which is the point of the change.
router.put('/locations/:id', requireRole('admin'), requireIntParams('id'), async (req, res) => {
  const { rows: cur } = await query('SELECT * FROM locations WHERE id=$1', [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Not found' });

  const name = req.body?.name === undefined ? cur[0].name : String(req.body.name).trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const sort = req.body?.sort_order === undefined ? cur[0].sort_order : Number(req.body.sort_order);
  if (!Number.isFinite(sort)) return res.status(400).json({ error: 'sort_order must be a number' });
  const active = req.body?.is_active === undefined ? cur[0].is_active : !!req.body.is_active;

  // Deactivating is always allowed — a location with history keeps its report
  // column for as long as the data references it, so nothing is orphaned. It
  // simply stops being offered on the entry screen.
  try {
    const { rows } = await query(
      `UPDATE locations SET name=$2, sort_order=$3, is_active=$4 WHERE id=$1 RETURNING *`,
      [req.params.id, name, sort, active]);
    await logActivity({ entityType: 'location', entityId: Number(req.params.id), action: 'update',
      detail: { from: cur[0].name, to: name, sort_order: sort, is_active: active },
      userId: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `"${name}" already exists` });
    throw err;
  }
});

// ── Move a location's entries somewhere real ───────────────────────────────
// A location that still holds counts cannot be deleted, and its column stays
// on the report for as long as the data does. That is the correct default —
// but it left an admin with no way out except editing the database by hand.
//
// This is the way out: move the entries to a location that IS one of the five,
// after which the stray holds nothing and the next cleanup removes it.
//
// The quantity is not touched — only where it is recorded. `location_text`
// keeps the original words, so the audit trail still shows what was first
// entered, and the move itself is logged with the counts.
router.post('/locations/:id/reassign', requireRole('admin'), requireIntParams('id'),
  async (req, res) => {
    const from = Number(req.params.id);
    const to = Number(req.body?.to_location_id);
    if (!Number.isInteger(to)) return res.status(400).json({ error: 'to_location_id required' });
    if (to === from) return res.status(400).json({ error: 'Choose a different location' });

    const { rows: locs } = await query(
      'SELECT id, name, is_active FROM locations WHERE id = ANY($1::int[])', [[from, to]]);
    const src = locs.find((l) => l.id === from);
    const dst = locs.find((l) => l.id === to);
    if (!src || !dst) return res.status(404).json({ error: 'Location not found' });
    if (!dst.is_active) {
      return res.status(400).json({ error: `"${dst.name}" is not in use — pick a live location` });
    }

    const moved = await withTransaction(async (c) => {
      const live = (await c.query(
        'UPDATE count_entries SET location_id=$2 WHERE location_id=$1', [from, to])).rowCount;
      // Submitted rows move too, or the reports would keep the old column.
      const submitted = (await c.query(
        'UPDATE submission_entries SET location_id=$2 WHERE location_id=$1', [from, to])).rowCount;
      await logActivity({
        entityType: 'location', entityId: from, action: 'reassign_entries',
        recordCount: live + submitted,
        detail: { from: src.name, to: dst.name, count_entries: live, submission_entries: submitted },
        userId: req.user.id,
      }, c);
      return { live, submitted };
    });

    res.json({ ok: true, from: src.name, to: dst.name, ...moved });
  });

// Hard delete only when nothing was ever counted there. Anything with history
// is deactivated instead, so no entry is left pointing at a location that no
// longer exists.
router.delete('/locations/:id', requireRole('admin'), requireIntParams('id'), async (req, res) => {
  const { rows: cur } = await query(
    `SELECT l.*, (SELECT count(*)::int FROM count_entries ce WHERE ce.location_id = l.id) AS entries
       FROM locations l WHERE l.id = $1`, [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Not found' });

  if (cur[0].entries > 0) {
    const { rows } = await query(
      'UPDATE locations SET is_active=FALSE WHERE id=$1 RETURNING *', [req.params.id]);
    await logActivity({ entityType: 'location', entityId: Number(req.params.id),
      action: 'deactivate', recordCount: cur[0].entries,
      detail: { name: cur[0].name, reason: 'location has count history' }, userId: req.user.id });
    return res.json({ ok: true, softDeleted: true, location: rows[0], entries: cur[0].entries });
  }
  await query('DELETE FROM locations WHERE id=$1', [req.params.id]);
  await logActivity({ entityType: 'location', entityId: Number(req.params.id), action: 'delete',
    detail: { name: cur[0].name }, userId: req.user.id });
  res.json({ ok: true, softDeleted: false });
});

export default router;
