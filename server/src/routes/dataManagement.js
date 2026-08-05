import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { logActivity } from '../lib/activityLog.js';
import { removePhotos, storage, keyFromUrl } from '../lib/storage.js';
import { config } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// DESTRUCTIVE DATA MANAGEMENT — admin only, every operation guarded.
//
// Rules applied uniformly here:
//   * admin role enforced server-side
//   * the exact confirmation phrase must be present in the request body; the
//     server validates it and rejects when absent or wrong
//   * multi-table deletions run inside ONE transaction
//   * object-storage deletion happens only AFTER the transaction commits, so
//     a storage failure can never orphan a database row
//   * every action is written to activity_log
// ═══════════════════════════════════════════════════════════════════════════
const router = Router();
router.use(requireAuth, requireRole('admin'));

// Rejects unless the body carries the exact phrase.
function confirmPhrase(req, res, phrase) {
  const given = (req.body?.confirm || '').trim();
  if (given.toUpperCase() !== phrase) {
    res.status(400).json({ error: `Type "${phrase}" to confirm`, requiredPhrase: phrase });
    return false;
  }
  return true;
}

const PHRASES = {
  deleteAllItems: 'DELETE ALL ITEMS',
  replaceMaster: 'REPLACE ITEM MASTER',
  deleteAudit: 'DELETE THIS AUDIT',
  clearEntries: 'CLEAR ALL ENTRIES',
  deleteDemo: 'DELETE DEMO DATA',
};

// ── Impact preview: what a destructive action would touch ──────────────────
router.get('/item-master/impact', async (_req, res) => {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM items) AS total_items,
            (SELECT count(*)::int FROM items WHERE is_active) AS active_items,
            (SELECT count(*)::int FROM count_entries WHERE NOT is_demo) AS entries,
            (SELECT count(DISTINCT audit_id)::int FROM count_entries WHERE NOT is_demo) AS audits_with_entries,
            (SELECT count(*)::int FROM count_entries WHERE is_demo) AS demo_entries,
            (SELECT count(*)::int FROM items WHERE photo_url IS NOT NULL) AS with_photos`
  );
  const r = rows[0];
  res.json({
    ...r,
    // An item that has ever been counted must never be hard deleted.
    blocked: r.entries > 0,
    blockedReason: r.entries > 0
      ? `Cannot delete. ${r.entries.toLocaleString()} count entries exist across ${r.audits_with_entries} audit(s). Delete or archive those audits first.`
      : null,
    requiredPhrase: PHRASES.deleteAllItems,
  });
});

// ── (2) Delete the entire item master ──────────────────────────────────────
router.post('/item-master/delete-all', async (req, res) => {
  const { rows: chk } = await query(
    `SELECT (SELECT count(*)::int FROM count_entries WHERE NOT is_demo) AS entries,
            (SELECT count(DISTINCT audit_id)::int FROM count_entries WHERE NOT is_demo) AS audits,
            (SELECT count(*)::int FROM items) AS items`
  );
  const { entries, audits, items } = chk[0];

  // Blocked whenever ANY count entry references any item — deleting would
  // orphan historical audit records.
  if (entries > 0) {
    return res.status(409).json({
      error: `Cannot delete. ${entries.toLocaleString()} count entries exist across ${audits} audit(s). Delete or archive those audits first.`,
      entries, audits, blocked: true,
    });
  }
  if (!confirmPhrase(req, res, PHRASES.deleteAllItems)) return;

  // Collect photo URLs before deleting so the bucket can be cleaned afterwards.
  const { rows: photoRows } = await query(
    'SELECT photo_url FROM items WHERE photo_url IS NOT NULL');

  const deleted = await withTransaction(async (c) => {
    // Demo entries are sample data, not history — cleared with the master.
    await c.query('DELETE FROM count_entries WHERE is_demo');
    await c.query('DELETE FROM audit_na');
    await c.query('DELETE FROM system_stock');
    await c.query('DELETE FROM photo_reviews');
    const { rowCount } = await c.query('DELETE FROM items');
    await logActivity({
      entityType: 'item_master', action: 'delete_all',
      recordCount: rowCount,
      detail: { items: rowCount, photos: photoRows.length },
      userId: req.user.id,
    }, c);
    return rowCount;
  });

  // Only after the commit.
  const photosRemoved = await removePhotos(photoRows.map((p) => p.photo_url));
  res.json({ ok: true, deleted, photosRemoved, itemsBefore: items });
});

// ── (7) Delete ONE item: hard delete only when never counted ───────────────
router.delete('/items/:id', requireIntParams('id'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: it } = await query('SELECT id, name, photo_url, is_active FROM items WHERE id=$1', [id]);
  if (!it[0]) return res.status(404).json({ error: 'Item not found' });

  const { rows: cnt } = await query(
    'SELECT count(*)::int AS n FROM count_entries WHERE item_id=$1', [id]);

  if (cnt[0].n > 0) {
    // Soft delete — the item has history and must stay referenceable.
    const { rows } = await query(
      `UPDATE items SET is_active=FALSE, deactivated_at=now(), deactivated_by=$2
        WHERE id=$1 RETURNING *`,
      [id, req.user.id]
    );
    await logActivity({
      entityType: 'item', entityId: id, action: 'deactivate', recordCount: 1,
      detail: { name: it[0].name, entries: cnt[0].n, reason: 'item has count history' },
      userId: req.user.id,
    });
    return res.json({ ok: true, softDeleted: true, item: rows[0], entries: cnt[0].n });
  }

  await withTransaction(async (c) => {
    await c.query('DELETE FROM system_stock WHERE item_id=$1', [id]);
    await c.query('DELETE FROM photo_reviews WHERE item_id=$1', [id]);
    await c.query('DELETE FROM audit_na WHERE item_id=$1', [id]);
    await c.query('DELETE FROM items WHERE id=$1', [id]);
    await logActivity({
      entityType: 'item', entityId: id, action: 'delete', recordCount: 1,
      detail: { name: it[0].name }, userId: req.user.id,
    }, c);
  });
  if (it[0].photo_url) await removePhotos([it[0].photo_url]);
  res.json({ ok: true, softDeleted: false });
});

// Reactivate a soft-deleted item.
router.post('/items/:id/reactivate', requireIntParams('id'), async (req, res) => {
  const { rows } = await query(
    `UPDATE items SET is_active=TRUE, deactivated_at=NULL, deactivated_by=NULL
      WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Item not found' });
  await logActivity({
    entityType: 'item', entityId: Number(req.params.id), action: 'reactivate',
    recordCount: 1, detail: { name: rows[0].name }, userId: req.user.id,
  });
  res.json({ ok: true, item: rows[0] });
});

// ── (4a) Delete a single audit, with its entries and system stock ──────────
router.get('/audits/:id/impact', requireIntParams('id'), async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.audit_date, a.status, s.name AS store_name, a.is_demo,
            (SELECT count(*)::int FROM count_entries WHERE audit_id=a.id) AS entries,
            (SELECT count(*)::int FROM count_entries WHERE audit_id=a.id AND photo_url IS NOT NULL) AS entry_photos,
            (SELECT count(*)::int FROM system_stock WHERE audit_id=a.id) AS system_rows,
            (SELECT count(*)::int FROM audit_na WHERE audit_id=a.id) AS na_rows
       FROM audits a JOIN stores s ON s.id=a.store_id WHERE a.id=$1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json({ ...rows[0], phrases: { delete: PHRASES.deleteAudit, clear: PHRASES.clearEntries } });
});

router.post('/audits/:id/delete', requireIntParams('id'), async (req, res) => {
  if (!confirmPhrase(req, res, PHRASES.deleteAudit)) return;
  const id = Number(req.params.id);
  const { rows: a } = await query(
    `SELECT a.id, a.audit_date, s.name AS store_name FROM audits a
       JOIN stores s ON s.id=a.store_id WHERE a.id=$1`, [id]);
  if (!a[0]) return res.status(404).json({ error: 'Audit not found' });

  const { rows: photoRows } = await query(
    'SELECT photo_url FROM count_entries WHERE audit_id=$1 AND photo_url IS NOT NULL', [id]);

  const counts = await withTransaction(async (c) => {
    const entries = (await c.query('DELETE FROM count_entries WHERE audit_id=$1', [id])).rowCount;
    const sys = (await c.query('DELETE FROM system_stock WHERE audit_id=$1', [id])).rowCount;
    const na = (await c.query('DELETE FROM audit_na WHERE audit_id=$1', [id])).rowCount;
    await c.query('DELETE FROM system_stock_imports WHERE audit_id=$1', [id]);
    await c.query('DELETE FROM photo_reviews WHERE audit_id=$1', [id]);
    await c.query('DELETE FROM audits WHERE id=$1', [id]);
    // audit_id is ON DELETE SET NULL, so this log entry survives its audit.
    await logActivity({
      entityType: 'audit', entityId: id, action: 'delete_audit',
      recordCount: entries,
      detail: { store: a[0].store_name, audit_date: a[0].audit_date,
                entries, system_stock: sys, not_applicable: na },
      userId: req.user.id,
    }, c);
    return { entries, sys, na };
  });

  const photosRemoved = await removePhotos(photoRows.map((p) => p.photo_url));
  res.json({ ok: true, ...counts, photosRemoved });
});

// ── (4b) Clear all count entries for an audit, keeping the audit ───────────
router.post('/audits/:id/clear-entries', requireIntParams('id'), async (req, res) => {
  if (!confirmPhrase(req, res, PHRASES.clearEntries)) return;
  const id = Number(req.params.id);
  const { rows: a } = await query('SELECT id FROM audits WHERE id=$1', [id]);
  if (!a[0]) return res.status(404).json({ error: 'Audit not found' });

  const { rows: photoRows } = await query(
    'SELECT photo_url FROM count_entries WHERE audit_id=$1 AND photo_url IS NOT NULL', [id]);

  const removed = await withTransaction(async (c) => {
    const entries = (await c.query('DELETE FROM count_entries WHERE audit_id=$1', [id])).rowCount;
    const na = (await c.query('DELETE FROM audit_na WHERE audit_id=$1', [id])).rowCount;
    // The audit itself stays, reopened at zero counted so the store can restart.
    await c.query(`UPDATE audits SET status='open', closed_at=NULL WHERE id=$1`, [id]);
    await logActivity({
      auditId: id, entityType: 'audit', entityId: id, action: 'clear_entries',
      recordCount: entries, detail: { entries, not_applicable: na },
      userId: req.user.id,
    }, c);
    return { entries, na };
  });

  const photosRemoved = await removePhotos(photoRows.map((p) => p.photo_url));
  res.json({ ok: true, ...removed, photosRemoved });
});

// ── (5) Demo data: what exists, and removing exactly those rows ────────────
export async function demoCounts() {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM users WHERE is_demo) AS users,
            (SELECT count(*)::int FROM stores WHERE is_demo) AS stores,
            (SELECT count(*)::int FROM items WHERE is_demo) AS items,
            (SELECT count(*)::int FROM audits WHERE is_demo) AS audits,
            (SELECT count(*)::int FROM count_entries WHERE is_demo) AS entries`
  );
  const c = rows[0];
  return { ...c, present: c.users + c.stores + c.items + c.audits + c.entries > 0 };
}

router.get('/demo', async (_req, res) => {
  res.json({ ...(await demoCounts()), requiredPhrase: PHRASES.deleteDemo });
});

// (4c) Delete demo data — identified by the is_demo FLAG, never by name.
router.post('/demo/delete', async (req, res) => {
  if (!confirmPhrase(req, res, PHRASES.deleteDemo)) return;
  const before = await demoCounts();

  // Entry photos belonging to demo entries, and demo item master photos.
  const { rows: entryPhotos } = await query(
    'SELECT photo_url FROM count_entries WHERE is_demo AND photo_url IS NOT NULL');
  const { rows: itemPhotos } = await query(
    'SELECT photo_url FROM items WHERE is_demo AND photo_url IS NOT NULL');

  const removed = await withTransaction(async (c) => {
    // Order matters for foreign keys.
    const entries = (await c.query('DELETE FROM count_entries WHERE is_demo')).rowCount;
    await c.query('DELETE FROM audit_na WHERE audit_id IN (SELECT id FROM audits WHERE is_demo)');
    await c.query('DELETE FROM system_stock WHERE audit_id IN (SELECT id FROM audits WHERE is_demo)');
    await c.query('DELETE FROM system_stock_imports WHERE audit_id IN (SELECT id FROM audits WHERE is_demo)');
    await c.query('DELETE FROM photo_reviews WHERE audit_id IN (SELECT id FROM audits WHERE is_demo)');
    const audits = (await c.query('DELETE FROM audits WHERE is_demo')).rowCount;

    // Demo items: only those never counted by a surviving (non-demo) entry.
    await c.query('DELETE FROM photo_reviews WHERE item_id IN (SELECT id FROM items WHERE is_demo)');
    await c.query('DELETE FROM system_stock WHERE item_id IN (SELECT id FROM items WHERE is_demo)');
    await c.query('DELETE FROM audit_na WHERE item_id IN (SELECT id FROM items WHERE is_demo)');
    const items = (await c.query(
      `DELETE FROM items WHERE is_demo
         AND NOT EXISTS (SELECT 1 FROM count_entries ce WHERE ce.item_id = items.id)`)).rowCount;
    // Demo items that still carry real history are deactivated, not removed.
    const deactivated = (await c.query(
      `UPDATE items SET is_active=FALSE, deactivated_at=now(), deactivated_by=$1
        WHERE is_demo AND is_active`, [req.user.id])).rowCount;

    await c.query('DELETE FROM user_stores WHERE user_id IN (SELECT id FROM users WHERE is_demo)');
    await c.query('DELETE FROM user_stores WHERE store_id IN (SELECT id FROM stores WHERE is_demo)');
    // Never delete the account performing the deletion.
    const users = (await c.query(
      'DELETE FROM users WHERE is_demo AND id <> $1', [req.user.id])).rowCount;
    const stores = (await c.query(
      `DELETE FROM stores WHERE is_demo
         AND NOT EXISTS (SELECT 1 FROM audits a WHERE a.store_id = stores.id)`)).rowCount;

    await logActivity({
      entityType: 'demo_data', action: 'delete_demo',
      recordCount: entries + items + audits + users + stores,
      detail: { before, deleted: { users, stores, items, audits, entries }, deactivated_items: deactivated },
      userId: req.user.id,
    }, c);
    return { users, stores, items, audits, entries, deactivated };
  });

  const photosRemoved = await removePhotos(
    [...entryPhotos, ...itemPhotos].map((p) => p.photo_url));
  // The account performing the deletion is never removed — doing so would lock
  // the admin out mid-operation. Report it so the remaining demo row is not
  // mistaken for a failure.
  const { rows: self } = await query('SELECT is_demo FROM users WHERE id=$1', [req.user.id]);
  res.json({
    ok: true, ...removed, photosRemoved, before,
    selfKept: !!self[0]?.is_demo,
    remaining: await demoCounts(),
  });
});

// ── (6) Activity log — read-only, newest first, never deletable ────────────
router.get('/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const { rows } = await query(
    `SELECT al.id, al.user_id, al.action,
            COALESCE(al.target_type, al.entity_type) AS target_type,
            COALESCE(al.target_id, al.entity_id) AS target_id,
            al.record_count, al.detail AS details, al.created_at, al.audit_id,
            u.name AS user_name, u.username
       FROM activity_log al
       LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

// ── (8) System readiness — the pre-count checklist ─────────────────────────
router.get('/readiness', async (req, res) => {
  const demo = await demoCounts();

  const { rows: stats } = await query(
    `SELECT (SELECT count(*)::int FROM items WHERE is_active) AS items,
            (SELECT count(*)::int FROM items WHERE is_active AND photo_url IS NULL) AS no_photo,
            (SELECT count(*)::int FROM items WHERE is_active AND is_liquor
                AND (bottle_size_ml IS NULL OR bottle_size_ml = 0)) AS liquor_no_size,
            (SELECT count(*)::int FROM users WHERE must_change_password AND is_active) AS default_pw,
            (SELECT count(*)::int FROM audits WHERE status = 'open') AS open_audits,
            (SELECT count(*)::int FROM audits WHERE status='open' AND audit_date < CURRENT_DATE) AS stale_audits`
  );
  const s = stats[0];

  // Object storage: a real write-then-delete round trip.
  let storageOk = false;
  let storageDetail = '';
  try {
    const probe = Buffer.from(`audix readiness probe ${Date.now()}`);
    const { url, key } = await storage.save(probe, {
      ext: '.txt', contentType: 'text/plain', name: 'readiness-probe',
    });
    const removed = await storage.remove(key || keyFromUrl(url));
    storageOk = !!url && removed;
    storageDetail = storageOk
      ? `${config.storageDriver} driver: test write and delete succeeded`
      : `${config.storageDriver} driver: wrote but could not delete the probe`;
  } catch (err) {
    storageDetail = `${config.storageDriver} driver: ${err.message}`;
  }

  const checks = [
    { key: 'demo_data', label: 'Demo data present', ok: !demo.present,
      detail: demo.present
        ? `${demo.users} users, ${demo.stores} stores, ${demo.items} items, ${demo.audits} audits, ${demo.entries} entries`
        : 'No demo records',
      action: demo.present ? 'delete_demo' : null },
    { key: 'default_passwords', label: 'Users still on a seeded default password', ok: s.default_pw === 0,
      detail: s.default_pw === 0 ? 'All users have set their own password'
                                 : `${s.default_pw} user(s) must change their password` },
    { key: 'item_master', label: 'Item master loaded', ok: s.items > 0,
      detail: `${s.items} active item(s)` },
    { key: 'photos', label: 'Items missing a photo', ok: s.no_photo === 0,
      detail: s.no_photo === 0 ? 'Every active item has a photo'
                               : `${s.no_photo} of ${s.items} active items have no photo` },
    { key: 'bottle_sizes', label: 'Liquor items missing bottle_size_ml', ok: s.liquor_no_size === 0,
      detail: s.liquor_no_size === 0 ? 'All liquor items have a bottle size'
                                     : `${s.liquor_no_size} liquor item(s) missing bottle_size_ml` },
    { key: 'storage', label: 'Object storage reachable', ok: storageOk, detail: storageDetail },
    { key: 'open_audits', label: 'Audits left open from a previous session', ok: s.stale_audits === 0,
      detail: s.stale_audits === 0
        ? `${s.open_audits} open audit(s), none from an earlier date`
        : `${s.stale_audits} audit(s) still open from an earlier date` },
  ];

  res.json({
    ready: checks.every((c) => c.ok),
    environment: config.nodeEnv,
    checks,
    demo,
  });
});

export default router;
