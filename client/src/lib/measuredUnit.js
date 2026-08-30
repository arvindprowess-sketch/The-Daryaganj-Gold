// ═══════════════════════════════════════════════════════════════════════════
// Two-box entry for whole-unit measures.
//
// 200 grams had to be typed as 0.200 — a leading zero and a decimal point, on
// a phone, 618 times. The decimal point is where the mistakes happen: 0.2 and
// 0.02 look almost identical on a small screen and differ by a factor of ten.
//
// So an item measured in KG gets [ kg ][ gm ] and one measured in LTR gets
// [ ltr ][ ml ], the same shape auditors already use for liquor. The STORED
// value never changes — it stays a single number in the item's own unit.
//
// Only a WHOLE-unit measure splits. The test is on the unit itself, not on
// anything found inside it:
//
//   "KG", "kg", "LTR"        → two boxes
//   "GM", "ML"               → one box; it is already the small unit
//   "TIN (2.5 KG)", "BTL (1LTR)" → one box; these count tins and bottles,
//                                  and the size lives in Bottle/Unit Size
// ═══════════════════════════════════════════════════════════════════════════

const KILO = /^(kgs?|kilos?|kilograms?)$/i;
const LITRE = /^(l|ltrs?|lts?|litres?|liters?)$/i;

// → { major, minor, per } or null when the unit takes a single box.
// `per` is how many minor units make one major.
export function subUnitFor(unit) {
  const u = String(unit || '').trim();
  if (KILO.test(u)) return { major: 'kg', minor: 'gm', per: 1000, label: 'KG' };
  if (LITRE.test(u)) return { major: 'ltr', minor: 'ml', per: 1000, label: 'LTR' };
  return null;
}

// Both boxes → the single stored number.
//
// Blank is zero, and the minor box is NOT capped: 2 kg + 1500 gm is 3.5 kg,
// not an error. An auditor who has counted 1500 g should be able to type it —
// rejecting the input would send them back to the arithmetic the two boxes
// exist to remove.
export function combine(major, minor, per = 1000) {
  const a = major === '' || major == null ? 0 : Number(major);
  const b = minor === '' || minor == null ? 0 : Number(minor);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || b < 0) return null;
  // Rounded to 3 decimals to match NUMERIC(14,3) in the database, and so the
  // preview under the boxes reads 5.200 rather than 5.199999999999999.
  return Number((a + b / per).toFixed(3));
}

// Splitting a stored value back into the two boxes, for editing an entry.
export function split(value, per = 1000) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return { major: '', minor: '' };
  const major = Math.floor(n);
  const minor = Math.round((n - major) * per);
  return { major: String(major), minor: minor ? String(minor) : '' };
}

// "= 5.200 KG" — shown live under the boxes so what is being saved is never
// in doubt.
export function preview(major, minor, sub) {
  const v = combine(major, minor, sub.per);
  if (v == null) return null;
  return `= ${v.toFixed(3)} ${sub.label}`;
}
