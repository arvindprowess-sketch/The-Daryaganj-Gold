import { verifyAccessToken } from '../lib/auth.js';
import { query } from '../db.js';

// Attaches req.user = { id, role, username, name } from a Bearer token.
// Signals `code` so the client can distinguish an expired token (refreshable)
// from a genuinely invalid one (must re-login).
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token', code: 'no_token' });
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      username: payload.username,
      name: payload.name,
    };
    next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Token expired' : 'Invalid token',
      code: expired ? 'token_expired' : 'token_invalid',
    });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Confirms the (auditor) user is mapped to the given store. Admins pass through.
export async function assertStoreAccess(user, storeId) {
  if (user.role === 'admin') return true;
  const { rowCount } = await query(
    'SELECT 1 FROM user_stores WHERE user_id = $1 AND store_id = $2',
    [user.id, storeId]
  );
  return rowCount > 0;
}

// Loads an audit and verifies the user may access its store.
export async function loadAuditForUser(user, auditId) {
  const { rows } = await query('SELECT * FROM audits WHERE id = $1', [auditId]);
  const audit = rows[0];
  if (!audit) return { audit: null, allowed: false };
  const allowed = await assertStoreAccess(user, audit.store_id);
  return { audit, allowed };
}
