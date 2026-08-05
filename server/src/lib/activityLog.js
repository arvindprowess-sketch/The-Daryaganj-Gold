import { query } from '../db.js';

// Append-only administrative audit trail. `detail` holds before/after values so
// a correction can be reconstructed later. Never updated or deleted.
export async function logActivity(
  { auditId = null, entityType, entityId = null, action, detail = {}, userId },
  client = null
) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO activity_log (audit_id, entity_type, entity_id, action, detail, user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [auditId, entityType, entityId, action, JSON.stringify(detail), userId]
  );
}

export async function activityFor(auditId, entityType = null) {
  const params = [auditId];
  let filter = '';
  if (entityType) { params.push(entityType); filter = ` AND al.entity_type = $${params.length}`; }
  const { rows } = await query(
    `SELECT al.*, u.name AS user_name
       FROM activity_log al
       LEFT JOIN users u ON u.id = al.user_id
      WHERE al.audit_id = $1${filter}
      ORDER BY al.created_at DESC
      LIMIT 200`,
    params
  );
  return rows;
}
