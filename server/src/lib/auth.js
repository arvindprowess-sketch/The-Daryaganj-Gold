import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username, name: user.name },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}
