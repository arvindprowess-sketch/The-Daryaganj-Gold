import { Router } from 'express';
import { query } from '../db.js';
import { verifyPassword, hashPassword, signTokens, signAccessToken, verifyRefreshToken } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { loginLimiter, refreshLimiter } from '../middleware/rateLimit.js';

const router = Router();

// The client IP as the proxy reports it. `app.set('trust proxy', …)` in
// index.js decides how much of X-Forwarded-For is believed.
const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

// Every rejected sign-in goes to the audit trail with the username tried and
// the source address, so a password-guessing run is visible after the fact
// rather than only in whatever the process happened to log to stdout.
// The password itself is NEVER recorded.
async function logFailedLogin(req, username, reason, userId = null) {
  try {
    await logActivity({
      entityType: 'auth', entityId: userId, action: 'login_failed', recordCount: 1,
      detail: {
        username: String(username || '').slice(0, 100),
        reason,
        ip: clientIp(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
      },
      userId,
    });
  } catch (err) {
    // A logging failure must never turn a rejected login into a 500.
    console.error('Failed to record a failed login:', err.message);
  }
}

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const { rows } = await query(
    'SELECT * FROM users WHERE lower(username) = lower($1)',
    [username]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    // The response stays deliberately identical for both cases — it must not
    // reveal whether the username exists — but the log distinguishes them.
    await logFailedLogin(req, username, user ? 'account_inactive' : 'unknown_username',
      user ? user.id : null);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await logFailedLogin(req, username, 'wrong_password', user.id);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const { token, refreshToken } = signTokens(user);
  res.json({
    token,
    refreshToken,
    user: {
      id: user.id, username: user.username, name: user.name, role: user.role,
      // Seeded accounts have a console-printed password and must replace it
      // before they can do anything else.
      must_change_password: !!user.must_change_password,
    },
  });
});

// Set a new password. Required immediately after logging in with a seeded
// default; usable at any time to change your own password.
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  if (!next || String(next).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await verifyPassword(String(current || ''), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  if (await verifyPassword(String(next), user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different from the current one' });
  }

  await query(
    `UPDATE users SET password_hash=$2, must_change_password=FALSE, password_changed_at=now()
      WHERE id=$1`,
    [user.id, await hashPassword(String(next))]
  );
  await logActivity({
    entityType: 'user', entityId: user.id, action: 'change_password',
    recordCount: 1, detail: { username: user.username, was_seeded: !!user.must_change_password },
    userId: user.id,
  });
  res.json({ ok: true });
});

// Exchange a valid refresh token for a fresh access token. The client calls
// this transparently on a 401 so an active session never drops.
router.post('/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  const { rows } = await query(
    'SELECT id, username, name, role, is_active FROM users WHERE id = $1',
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'User inactive' });
  res.json({
    token: signAccessToken(user),
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
  });
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT id, username, name, role, must_change_password FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ user: rows[0] || null });
});

export default router;
