// ═══════════════════════════════════════════════════════════════════════════
// THE column set. Defined once, here.
//
// R1, R2, R3 and R4 each used to build their own columns, and they drifted:
// R4 grew the per-location columns while R3 was still returning six fields.
// Four reports of the same audit disagreeing about what a row looks like is a
// defect in an audit product — a reader cannot reconcile one against another.
//
// So there is one definition. Every report, every Excel sheet and every PDF
// reads its columns from here, in this order. The location columns are not
// listed: they are spliced in from the locations table in sort_order, so
// renaming a location renames its column everywhere at once.
// ═══════════════════════════════════════════════════════════════════════════

// Before the location columns.
const HEAD = [
  { key: 's_no', label: 'S.No.', align: 'right' },
  { key: 'loc', label: 'LOC' },
  { key: 'super_category', label: 'Super Category' },
  { key: 'category', label: 'Category' },
  { key: 'name', label: 'Item Name' },
  { key: 'unit', label: 'Unit' },
  { key: 'bottle_unit_size', label: 'Bottle/Unit Size (ml)', align: 'right' },
];

// After them.
const TAIL = [
  { key: 'location_total', label: 'Total (native unit)', align: 'right', qty: true },
  { key: 'loose_ml', label: 'ML / Loose Qty (Open Bottle, ml)', align: 'right', qty: true },
  { key: 'final_total_qty', label: 'Final Total Qty (ML / GM / KG / Count)', align: 'right', qty: true },
  { key: 'remarks', label: 'Remarks' },
];

// Appended only when system stock exists. Nothing about the base columns
// changes when they appear.
//
// `money: true` marks a column that is BLANK when the item has no rate. A rate
// nobody has entered and a price of zero are different things, and an audit
// report must never let them look the same.
const SYSTEM = [
  { key: 'system_qty', label: 'System Qty', align: 'right' },
  { key: 'rate', label: 'Rate', align: 'right', money: true },
  { key: 'physical_value', label: 'Physical Value', align: 'right', money: true },
  { key: 'system_value', label: 'System Value', align: 'right', money: true },
  { key: 'variance', label: 'Variance', align: 'right' },
  { key: 'variance_value', label: 'Variance Value', align: 'right', money: true },
  { key: 'status', label: 'Status' },
];

// locations: [{ id, name }] in sort_order — one column each, keyed by index
// into a row's `by_location` array.
export function locationFields(locations = []) {
  return locations.map((l, i) => ({
    key: `loc:${i}`, label: l.name, align: 'right', qty: true, locationIndex: i,
  }));
}

export function reportFields(locations = [], { withSystem = false } = {}) {
  return [...HEAD, ...locationFields(locations), ...TAIL, ...(withSystem ? SYSTEM : [])];
}

export const reportColumns = (locations, opts) =>
  reportFields(locations, opts).map((f) => f.label);

export const reportAlign = (locations, opts) =>
  reportFields(locations, opts).map((f) => f.align || '');

// One row's value for one column. Used by the Excel and PDF exporters so a
// figure cannot be read differently in two places.
export function fieldValue(row, field) {
  if (field.locationIndex != null) return row.by_location?.[field.locationIndex] ?? 0;
  return row[field.key];
}

// The subtotal / grand-total version of a row. A subtotal carries the same
// figures in the same columns, so a column reads straight down from an item to
// the grand total; anything that cannot be summed is blank rather than
// misleading (there is no such thing as a subtotal of a unit name).
const SUMMABLE = new Set([
  'location_total', 'loose_ml', 'final_total_qty',
  'system_qty', 'physical_value', 'system_value', 'variance', 'variance_value',
]);

export function bucketValue(bucket, field) {
  if (field.locationIndex != null) return bucket.by_location?.[field.locationIndex] ?? 0;
  if (SUMMABLE.has(field.key)) return bucket[field.key];
  return null;
}

export const isSummable = (field) => field.locationIndex != null || SUMMABLE.has(field.key);
