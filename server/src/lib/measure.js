// ═══════════════════════════════════════════════════════════════════════════
// The measurement basis of an item, and the Final Total Qty formula.
//
// The client's standard audit report expresses every item in its base unit —
// millilitres, grams, kilos, or a plain count — rather than in packs. ONE
// formula covers the whole master:
//
//   Store+Outlet Total = Store Room Qty + Outlet Qty
//   Final Total Qty    = (Store+Outlet Total × Bottle/Unit Size) + Loose ML
//
// A count-based item carries a size of 1, so the multiplier has no effect and
// the count passes through unchanged. That is why there is no special case for
// liquor here: a 750 ML bottle is just an item whose size is 750.
// ═══════════════════════════════════════════════════════════════════════════

// The Remarks column: what the Final Total Qty is expressed in.
//
// Precedence is deliberate. A MEASURED unit inside the label wins over the
// container word, because the size multiplier converts packs into that measure:
// "PKT (500 GM)" totals in GM, while a bare "PKT" — nothing to convert to —
// stays PKT. Checked in this order:
//
//   KG · GM · ML (litres included) · Meter · PIECE · POR · PKT · Nos
//
// Every rule opens with `(?<![A-Za-z])` rather than `\b`. A word boundary is
// the wrong test here: the client writes "BTL (1LTR)" and "BOT-680G", where the
// measure sits hard against a digit and there IS no boundary, so `\bLTR\b`
// never fires. "Not preceded by a letter" accepts those and still rejects the
// measure appearing inside a longer word — "PKG" is not KG.
const BASIS_RULES = [
  [/(?<![A-Za-z])(KGS?|KILOS?|KILOGRAMS?)\b/i, 'KG'],
  // "GM", "GMS", and the trailing form the client writes as "BOT-680G".
  [/(?<![A-Za-z])(GMS?|GRAMS?)\b|\d\s*G\b/i, 'GM'],
  // Litres are reported in millilitres, since the size is given in ml.
  [/(?<![A-Za-z])(MLS?|LTRS?|LITRES?|LITERS?|L)\b/i, 'ML'],
  [/(?<![A-Za-z])(MTRS?|METERS?|METRES?)\b/i, 'Meter'],
  [/(?<![A-Za-z])(PCS?|PIECES?)\b/i, 'PIECE'],
  [/(?<![A-Za-z])(POR|PORTIONS?)\b/i, 'POR'],
  [/(?<![A-Za-z])(PKTS?|PACKETS?|PACKS?)\b/i, 'PKT'],
];

export function measurementBasis(unit) {
  const u = String(unit || '').trim();
  if (!u) return 'Nos';
  // A Unit that is nothing but a number is a bottle size in millilitres. That
  // is how this client's master records liquor — "750", "700", "1000" sit in
  // the Unit column instead of a unit word — and reading it as a count would
  // report a spirits shelf in "Nos".
  if (/^\d+(\.\d+)?$/.test(u)) return 'ML';
  for (const [re, basis] of BASIS_RULES) if (re.test(u)) return basis;
  return 'Nos';
}

// Every basis the report can produce, in the order the summary block lists
// them. Exported so the summary header can show a zero count for a basis the
// audit happens not to contain, rather than silently omitting the row.
export const BASES = ['ML', 'GM', 'KG', 'Nos', 'POR', 'PKT', 'PIECE', 'Meter'];

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// Rounded to 3 decimals: quantities are NUMERIC(14,3) in the database, and a
// float multiplication would otherwise show 1249.9999999999998.
const round3 = (n) => Number(Number(n).toFixed(3));

// The one calculation the whole report is built on.
//   storeRoom / outlet — native quantity counted in each zone
//   size               — items.bottle_unit_size (1 for count-based items)
//   looseMl            — open-bottle millilitres, added AFTER the multiplier
//                        because it is already in the base measure
export function finalTotals({ storeRoom, outlet, size, looseMl }) {
  const storeRoomQty = round3(num(storeRoom));
  const outletQty = round3(num(outlet));
  const storeOutletTotal = round3(storeRoomQty + outletQty);
  const unitSize = num(size) > 0 ? num(size) : 1;
  const loose = round3(num(looseMl));
  return {
    store_room_qty: storeRoomQty,
    outlet_qty: outletQty,
    store_outlet_total: storeOutletTotal,
    loose_ml: loose,
    final_total_qty: round3(storeOutletTotal * unitSize + loose),
  };
}
