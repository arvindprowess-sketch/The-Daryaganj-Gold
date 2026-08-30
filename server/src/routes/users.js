import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { hashPassword } from '../lib/auth.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireIntParams } from '../lib/asyncRoutes.js';
import { logActivity } from '../lib/activityLog.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// ── List users with their store mappings ───────────────────────────────────
// [Active] [Inactive] [All]. An inactive user is one that was deleted while it
// still had count entries: kept so historical reports still resolve the name,
// but unable to log in (see routes/auth.js) and absent from every dropdown.
router.get('/', async (req, res) => {
  const active = ['inactive', 'all'].includes(req.query.active) ? req.query.active : 'active';
  const where = active === 'active' ? 'WHERE u.is_active'
              : active === 'inactive' ? 'WHERE NOT u.is_active' : '';
  const { rows } = await query(
    `SELECT u.id, u.username, u.name, u.role, u.is_active, u.created_at,
            u.deactivated_at, d.name AS deactivated_by_name,
            (SELECT count(*)::int FROM count_entries ce WHERE ce.counted_by = u.id) AS entry_count,
            COALESCE(
              (SELECT json_agg(us.store_id) FROM user_stores us WHERE us.user_id = u.id),
              '[]'
            ) AS store_ids
       FROM users u
       LEFT JOIN users d ON d.id = u.deactivated_by
       ${where}
       ORDER BY u.role, u.name`
  );
  const { rows: counts } = await query(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive,
            count(*)::int AS all_users
       FROM users`
  );
  res.json({ users: rows, counts: counts[0] });
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
        // must_change_password: an admin choosing a password means the admin
        // KNOWS it — it was typed here and passed on by message. The account
        // is not the auditor's own until they have set their own password, and
        // an audit trail that says "Rakesh counted this" has to mean Rakesh.
        // The create:admin CLI already works this way; this is the same rule.
        `INSERT INTO users (username, name, password_hash, role, is_active,
                            must_change_password)
         VALUES ($1, $2, $3, $4, $5, TRUE)
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

router.put('/:id', requireIntParams('id'), async (req, res) => {
  const { name, role, password, is_active, store_ids } = req.body || {};
  const passwordHash = password ? await hashPassword(password) : null;
  const updated = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         role = COALESCE($3, role),
         is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash),
         -- A password RESET by an admin is the same situation: they know it,
         -- so the user changes it at their next login.
         must_change_password = CASE WHEN $5::text IS NULL
                                     THEN must_change_password ELSE TRUE END
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

// ── What deleting this user would actually do ──────────────────────────────
// The screen asks first, so the confirmation can state the real outcome rather
// than a guess. The server makes the same decision again when the delete runs.
async function deleteImpact(id) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM count_entries WHERE counted_by = $1) AS entries,
            (SELECT count(DISTINCT audit_id)::int FROM count_entries WHERE counted_by = $1) AS audits,
            -- Other history that also carries a NOT NULL reference to this user.
            (SELECT count(*)::int FROM audit_na WHERE marked_by = $1) AS na_marks,
            (SELECT count(*)::int FROM photo_reviews WHERE submitted_by = $1) AS photo_reviews,
            (SELECT count(*)::int FROM user_stores WHERE user_id = $1) AS store_links,
            -- A submission and its rows also carry a permanent reference. An
            -- auditor whose live entries were cleared but who has submitted
            -- would otherwise reach the hard-delete branch and fail on a
            -- foreign key.
            (SELECT count(*)::int FROM audit_submissions WHERE submitted_by = $1) AS submissions,
            (SELECT count(*)::int FROM submission_entries WHERE counted_by = $1) AS submitted_rows`,
    [id]
  );
  const r = rows[0];
  const history = r.entries + r.na_marks + r.photo_reviews + r.submissions + r.submitted_rows;
  return {
    ...r,
    // Anything that references the account permanently makes this a soft delete;
    // hard deleting would orphan an audit record.
    softDelete: history > 0,
    reason: r.entries > 0
      ? `${r.entries.toLocaleString()} count entries across ${r.audits} audit(s)`
      : r.na_marks > 0 ? `${r.na_marks} not-applicable mark(s)`
      : r.photo_reviews > 0 ? `${r.photo_reviews} photo submission(s)`
      : r.submissions > 0 ? `${r.submissions} submitted count(s)`
      : null,
  };
}

router.get('/:id/impact', requireIntParams('id'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT id, name, username, role, is_active FROM users WHERE id=$1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ ...rows[0], ...(await deleteImpact(id)), isSelf: id === Number(req.user.id) });
});

// ── Delete a user ──────────────────────────────────────────────────────────
// Has count entries → DEACTIVATE, so historical entries keep their reference.
// No history at all   → hard delete.
// Never your own account, whatever the history.
router.delete('/:id', requireIntParams('id'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) {
    return res.status(400).json({
      error: 'You cannot delete your own account. Ask another admin to do it.',
      code: 'self_delete',
    });
  }
  const { rows: u } = await query(
    'SELECT id, name, username, role, is_active FROM users WHERE id=$1', [id]);
  if (!u[0]) return res.status(404).json({ error: 'User not found' });

  const impact = await deleteImpact(id);

  if (impact.softDelete) {
    const { rows } = await query(
      `UPDATE users SET is_active=FALSE, deactivated_at=now(), deactivated_by=$2
        WHERE id=$1 RETURNING id, username, name, role, is_active, deactivated_at`,
      [id, req.user.id]
    );
    await logActivity({
      entityType: 'user', entityId: id, action: 'deactivate', recordCount: 1,
      detail: { username: u[0].username, name: u[0].name, role: u[0].role,
                entries: impact.entries, reason: impact.reason },
      userId: req.user.id,
    });
    return res.json({ ok: true, softDeleted: true, user: rows[0], ...impact });
  }

  await withTransaction(async (c) => {
    // Nullable references to the account are cleared first so the row can go.
    // None of these are audit history — they are "who touched this last".
    await c.query('DELETE FROM user_stores WHERE user_id=$1', [id]);
    await c.query('UPDATE audits SET created_by=NULL WHERE created_by=$1', [id]);
    await c.query('UPDATE count_entries SET voided_by=NULL WHERE voided_by=$1', [id]);
    await c.query('UPDATE system_stock SET created_by=NULL WHERE created_by=$1', [id]);
    await c.query('UPDATE system_stock SET updated_by=NULL WHERE updated_by=$1', [id]);
    await c.query('UPDATE system_stock_imports SET imported_by=NULL WHERE imported_by=$1', [id]);
    await c.query('UPDATE photo_reviews SET reviewed_by=NULL WHERE reviewed_by=$1', [id]);
    await c.query('UPDATE items SET deactivated_by=NULL WHERE deactivated_by=$1', [id]);
    await c.query('UPDATE users SET deactivated_by=NULL WHERE deactivated_by=$1', [id]);
    // activity_log.user_label already holds a snapshot of the name, so the
    // trail still reads correctly once the foreign key is cleared.
    await c.query('UPDATE activity_log SET user_id=NULL WHERE user_id=$1', [id]);
    await c.query('DELETE FROM users WHERE id=$1', [id]);
    await logActivity({
      entityType: 'user', entityId: id, action: 'delete', recordCount: 1,
      detail: { username: u[0].username, name: u[0].name, role: u[0].role,
                store_links_removed: impact.store_links },
      userId: req.user.id,
    }, c);
  });
  res.json({ ok: true, softDeleted: false, ...impact });
});

// Reactivate a deactivated user. Store assignments were kept, so the account
// comes back exactly as it was.
router.post('/:id/reactivate', requireIntParams('id'), async (req, res) => {
  const { rows } = await query(
    `UPDATE users SET is_active=TRUE, deactivated_at=NULL, deactivated_by=NULL
      WHERE id=$1 RETURNING id, username, name, role, is_active`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  await logActivity({
    entityType: 'user', entityId: Number(req.params.id), action: 'reactivate',
    recordCount: 1, detail: { username: rows[0].username, name: rows[0].name },
    userId: req.user.id,
  });
  res.json({ ok: true, user: rows[0] });
});

export default router;
