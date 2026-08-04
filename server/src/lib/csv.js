// Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines in quotes).
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop trailing fully-empty rows
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Parse to array of objects keyed by header (lower-cased, trimmed).
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, records };
}
