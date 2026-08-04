import { Router } from 'express';
import { query } from '../db.js';
import { verifyPassword, signTokens, signAccessToken, verifyRefreshToken } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
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
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const { token, refreshToken } = signTokens(user);
  res.json({
    token,
    refreshToken,
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
  });
});

// Exchange a valid refresh token for a fresh access token. The client calls
// this transparently on a 401 so an active session never drops.
router.post('/refresh', async (req, res) => {
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
    'SELECT id, username, name, role FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ user: rows[0] || null });
});

export default router;
