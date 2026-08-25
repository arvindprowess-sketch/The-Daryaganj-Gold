// ═══════════════════════════════════════════════════════════════════════════
// Date formatting that never prints "Invalid Date".
//
// A timestamp is part of the audit trail, so a missing or malformed one must
// read as "we don't have this" — an em dash, or nothing at all — never as a
// broken-looking string sitting next to real audit data.
//
// `new Date(undefined)`, `new Date({})` and `new Date('not a date')` all
// produce an Invalid Date whose toLocale*() methods return the literal string
// "Invalid Date". Every render below goes through parse() instead.
// ═══════════════════════════════════════════════════════════════════════════

// Returns a valid Date, or null. Accepts an ISO string, an epoch number, or a
// Date. Anything else — including the `{}` a bad serialisation can produce —
// comes back null.
export function parse(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "14:05"
export function fmtTime(value, fallback = '') {
  const d = parse(value);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : fallback;
}

// "25/08/2026"
export function fmtDate(value, fallback = '—') {
  const d = parse(value);
  return d ? d.toLocaleDateString() : fallback;
}

// "25/08/2026, 14:05:33"
export function fmtDateTime(value, fallback = '—') {
  const d = parse(value);
  return d ? d.toLocaleString() : fallback;
}
