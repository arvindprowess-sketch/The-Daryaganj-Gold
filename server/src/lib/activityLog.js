import { query } from '../db.js';

// Append-only administrative audit trail. `detail` holds before/after values so
// a correction can be reconstructed later. Never updated or deleted.
export async function logActivity(
  { auditId = null, entityType, entityId = null, action, detail = {}, userId,
    recordCount = null },
  client = null
) {
  const run = client ? client.query.bind(client) : query;
  // target_type / target_id mirror entity_type / entity_id: the data-management
  // screens use the "target" wording, the older system-stock rows use "entity".
  //
  // user_label is a SNAPSHOT of who acted. user_id is a foreign key, so it goes
  // away when an account is hard deleted; the snapshot keeps the audit trail
  // answering "who did this" regardless.
  await run(
    `INSERT INTO activity_log
       (audit_id, entity_type, entity_id, target_type, target_id,
        action, detail, user_id, record_count, user_label)
     VALUES ($1,$2,$3,$2,$3,$4,$5,$6,$7,
             (SELECT name || ' (' || username || ')' FROM users WHERE id = $6))`,
    [auditId, entityType, entityId, action, JSON.stringify(detail), userId, recordCount]
  );
}

export async function activityFor(auditId, entityType = null) {
  const params = [auditId];
  let filter = '';
  if (entityType) { params.push(entityType); filter = ` AND al.entity_type = $${params.length}`; }
  const { rows } = await query(
    `SELECT al.*, COALESCE(u.name, al.user_label) AS user_name
       FROM activity_log al
       LEFT JOIN users u ON u.id = al.user_id
      WHERE al.audit_id = $1${filter}
      ORDER BY al.created_at DESC
      LIMIT 200`,
    params
  );
  return rows;
}
