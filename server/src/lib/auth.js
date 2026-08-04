import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── Access + refresh tokens ─────────────────────────────────────────────────
// An auditor must never be logged out mid-count. Access tokens are short-lived
// and silently refreshed by the client using a long-lived refresh token, so an
// active user's session effectively never expires.
//
// The `typ` claim is checked on every use so a refresh token can never be
// presented as an access token (and vice versa).

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username, name: user.name, typ: 'access' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function signRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, typ: 'refresh' },
    config.jwtSecret,
    { expiresIn: config.jwtRefreshExpiresIn }
  );
}

export function signTokens(user) {
  return { token: signAccessToken(user), refreshToken: signRefreshToken(user) };
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
  // Tokens issued before the typ claim existed are treated as access tokens.
  if (payload.typ && payload.typ !== 'access') {
    const err = new Error('Wrong token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
  if (payload.typ !== 'refresh') {
    const err = new Error('Wrong token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}
