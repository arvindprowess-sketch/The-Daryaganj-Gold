// ═══════════════════════════════════════════════════════════════════════════
// BLIND COUNT enforcement (Design Rule #1)
//
// An auditor must NEVER receive system quantity, expected quantity, rates,
// values, or any prior-period figure. This is enforced server-side by stripping
// these fields from any payload before it is serialized to an auditor. Do not
// rely on the UI hiding them — every response passes through here.
// ═══════════════════════════════════════════════════════════════════════════

// Fields that must never reach an auditor, on any object shape.
const FORBIDDEN_FOR_AUDITOR = new Set([
  'rate',
  'value',
  'amount',
  // R4 splits the single `value` field into three. All three are rupee figures
  // derived from the rate and must be stripped for exactly the same reason.
  'physical_value',
  'physicalValue',
  'system_value',
  'systemValue',
  'variance_value',
  'varianceValue',
  'system_qty',
  'systemQty',
  'expected_qty',
  'expectedQty',
  'prior_qty',
  'priorQty',
  'prior_period',
  'priorPeriod',
  'variance',
  'variance_pct',
  'variancePct',
  'book_qty',
  'bookQty',
]);

// Only a PLAIN object may be rebuilt key by key.
//
// A Date — which is what node-postgres returns for every TIMESTAMPTZ column —
// has no own enumerable properties, so `Object.entries(date)` is `[]` and
// rebuilding it produces `{}`. That serialised to `"counted_at": {}` and made
// `new Date(...)` render "Invalid Date" on the auditor's screen for every
// entry. The same silently applied to voided_at, marked_at and audit_date, and
// would apply to any Buffer or class instance added later.
//
// Admins never saw it because forRole() returns their payload untouched.
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function scrubObject(obj) {
  if (Array.isArray(obj)) return obj.map(scrubObject);
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_FOR_AUDITOR.has(k)) continue;
      out[k] = scrubObject(v);
    }
    return out;
  }
  // Dates, Buffers and anything else with a prototype pass through unchanged.
  return obj;
}

// Strip forbidden fields if (and only if) the requesting user is an auditor.
export function forRole(role, payload) {
  if (role === 'admin') return payload;
  return scrubObject(payload);
}
