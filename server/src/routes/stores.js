import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { logActivity } from '../lib/activityLog.js';

const router = Router();
router.use(requireAuth);

// ── List stores ────────────────────────────────────────────────────────────
// ACTIVE ONLY by default, for everyone. Every dropdown and counting screen in
// the app calls this endpoint plainly, so the default is what keeps a deleted
// store out of them. The management screen asks for `inactive` / `all`
// explicitly. Auditors additionally see only their assigned stores.
router.get('/', async (req, res) => {
  const active = ['inactive', 'all'].includes(req.query.active) ? req.query.active : 'active';
  if (req.user.role === 'admin') {
    const where = active === 'active' ? 'WHERE s.is_active'
                : active === 'inactive' ? 'WHERE NOT s.is_active' : '';
    const { rows } = await query(
      `SELECT s.*, d.name AS deactivated_by_name,
              (SELECT count(*)::int FROM audits a WHERE a.store_id = s.id) AS audit_count,
              (SELECT count(*)::int FROM user_stores us WHERE us.store_id = s.id) AS user_count
         FROM stores s
         LEFT JOIN users d ON d.id = s.deactivated_by
         ${where}
         ORDER BY s.name`
    );
    return res.json(rows);
  }
  // Auditors never see an inactive store, whatever they ask for.
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

router.put('/:id', requireRole('admin'), requireIntParams('id'), async (req, res) => {
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

// ── What deleting this store would actually do ─────────────────────────────
async function deleteImpact(id) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM audits WHERE store_id = $1) AS audits,
            (SELECT count(*)::int FROM count_entries ce
               JOIN audits a ON a.id = ce.audit_id WHERE a.store_id = $1) AS entries,
            (SELECT count(*)::int FROM user_stores WHERE store_id = $1) AS user_links`,
    [id]
  );
  const r = rows[0];
  return {
    ...r,
    // Any audit against the store makes this a soft delete: hard deleting would
    // orphan every audit, entry and report that references it.
    softDelete: r.audits > 0,
    reason: r.audits > 0
      ? `${r.audits} audit(s) with ${r.entries.toLocaleString()} count entries`
      : null,
  };
}

router.get('/:id/impact', requireRole('admin'), requireIntParams('id'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT id, code, name, is_active FROM stores WHERE id=$1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json({ ...rows[0], ...(await deleteImpact(id)) });
});

// ── Delete a store ─────────────────────────────────────────────────────────
// Has audits → DEACTIVATE, so those audits and their reports stay intact.
// No audits  → hard delete.
// Either way the user-to-store mappings go: the store is no longer to be
// counted, so no auditor should still be assigned to it.
router.delete('/:id', requireRole('admin'), requireIntParams('id'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: s } = await query(
    'SELECT id, code, name, is_active FROM stores WHERE id=$1', [id]);
  if (!s[0]) return res.status(404).json({ error: 'Store not found' });

  const impact = await deleteImpact(id);

  if (impact.softDelete) {
    const store = await withTransaction(async (c) => {
      await c.query('DELETE FROM user_stores WHERE store_id=$1', [id]);
      const { rows } = await c.query(
        `UPDATE stores SET is_active=FALSE, deactivated_at=now(), deactivated_by=$2
          WHERE id=$1 RETURNING *`,
        [id, req.user.id]
      );
      await logActivity({
        entityType: 'store', entityId: id, action: 'deactivate', recordCount: 1,
        detail: { code: s[0].code, name: s[0].name, audits: impact.audits,
                  entries: impact.entries, mappings_removed: impact.user_links,
                  reason: impact.reason },
        userId: req.user.id,
      }, c);
      return rows[0];
    });
    return res.json({ ok: true, softDeleted: true, store, ...impact });
  }

  await withTransaction(async (c) => {
    await c.query('DELETE FROM user_stores WHERE store_id=$1', [id]);
    await c.query('UPDATE stores SET deactivated_by=NULL WHERE deactivated_by=$1', [id]);
    await c.query('DELETE FROM stores WHERE id=$1', [id]);
    await logActivity({
      entityType: 'store', entityId: id, action: 'delete', recordCount: 1,
      detail: { code: s[0].code, name: s[0].name, mappings_removed: impact.user_links },
      userId: req.user.id,
    }, c);
  });
  res.json({ ok: true, softDeleted: false, ...impact });
});

// Reactivate a deactivated store. Auditor assignments were removed by the
// delete, so they have to be set again — the response says so.
router.post('/:id/reactivate', requireRole('admin'), requireIntParams('id'), async (req, res) => {
  const { rows } = await query(
    `UPDATE stores SET is_active=TRUE, deactivated_at=NULL, deactivated_by=NULL
      WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  await logActivity({
    entityType: 'store', entityId: Number(req.params.id), action: 'reactivate',
    recordCount: 1, detail: { code: rows[0].code, name: rows[0].name },
    userId: req.user.id,
  });
  res.json({ ok: true, store: rows[0], reassignAuditors: true });
});

export default router;
