import rateLimit from 'express-rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// Rate limiting — AUTHENTICATION ONLY.
//
// The login endpoint is the one place an attacker can guess their way in, and
// bcrypt makes each attempt cheap for them and expensive for us. Everything
// else is left alone on purpose: an auditor counting 618 items submits entries
// as fast as they can type, and throttling that would break a count night.
// ═══════════════════════════════════════════════════════════════════════════
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function limiter({ max, message }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    // Return the count in the standard RateLimit-* headers; drop the legacy
    // X-RateLimit-* ones.
    standardHeaders: true,
    legacyHeaders: false,
    // A clear 429 in the same { error } shape every other endpoint uses, so
    // the client surfaces it like any other message instead of "Request
    // failed (429)".
    handler: (_req, res) => res.status(429).json({ error: message, code: 'rate_limited' }),
  });
}

// 10 attempts per IP per 15 minutes. A person who has forgotten their password
// tries three or four times; a script tries thousands.
export const loginLimiter = limiter({
  max: 10,
  message: 'Too many sign-in attempts from this network. Wait 15 minutes and try again, '
         + 'or ask an admin to reset your password.',
});

// Refresh is called automatically by every open tab whenever an access token
// expires, so its ceiling is far higher — it exists to stop a stolen refresh
// token being ground against the endpoint, not to limit ordinary use.
export const refreshLimiter = limiter({
  max: 60,
  message: 'Too many session refreshes from this network. Wait 15 minutes and sign in again.',
});
