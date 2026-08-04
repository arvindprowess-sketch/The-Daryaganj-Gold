// ═══════════════════════════════════════════════════════════════════════════
// Item NAME is the single identifier (item codes were removed). Every place
// that compares or stores a name must go through here so matching is
// consistent: trim, collapse internal whitespace, compare case-insensitively.
// ═══════════════════════════════════════════════════════════════════════════

// Canonical stored form: trimmed, internal runs of whitespace collapsed to one
// space. Original casing is preserved for display.
export function normalizeName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

// Comparison key: normalized + lower-cased.
export function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

// Builds a Map from nameKey -> row for fast lookups during imports.
export function indexByName(rows, nameField = 'name') {
  const map = new Map();
  for (const r of rows) map.set(nameKey(r[nameField]), r);
  return map;
}
