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
  const rows = parseCsv(stripBom(text));
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, records };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reading an uploaded CSV, with a REASON when it cannot be read.
//
// "Import failed" on its own tells the admin nothing and leaves them guessing
// whether the file, the column names or the server is at fault. Every failure
// below names the actual cause and, where it can, what to do about it.
// ═══════════════════════════════════════════════════════════════════════════

// Excel's "CSV UTF-8" writes a byte-order mark. Left in place it becomes part
// of the first header name, so `item_name` silently stops matching.
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export class CsvFormatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CsvFormatError';
    this.code = code;
    this.status = 400;
  }
}

// File types that are commonly handed over as "the CSV" but are not one.
const SIGNATURES = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], what: 'an Excel workbook (.xlsx) or a zip archive',
    fix: 'Open it in Excel and choose File → Save As → CSV.' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], what: 'an old-format Excel workbook (.xls)',
    fix: 'Open it in Excel and choose File → Save As → CSV.' },
  { bytes: [0x25, 0x50, 0x44, 0x46], what: 'a PDF', fix: 'Export the data as CSV instead.' },
];

function describeBinary(buf) {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig;
  }
  // A NUL byte never appears in text; UTF-16 output from some tools is the
  // usual culprit.
  if (buf.subarray(0, 4096).includes(0x00)) {
    return { what: 'a binary file, not text',
             fix: 'Re-save it as CSV (UTF-8) and try again.' };
  }
  return null;
}

// Returns { text, filename, headers, records }. Throws CsvFormatError with a
// specific message when the upload cannot be turned into rows.
//
// `requireColumns` is a list of alternatives per required column, e.g.
// [['item_name', 'name']] — the first name is the one quoted in the error.
export function readCsvUpload(req, { requireColumns = [] } = {}) {
  const buf = req.file?.buffer ?? null;
  const pasted = req.body?.csv;
  const filename = req.file?.originalname || req.body?.filename || 'pasted-data.csv';

  if (!buf && !pasted) {
    throw new CsvFormatError(
      'Import failed — no file was received. Choose a CSV file and try again.', 'no_file');
  }
  if (buf && buf.length === 0) {
    throw new CsvFormatError(`Import failed — "${filename}" is empty (0 bytes).`, 'empty_file');
  }

  if (buf) {
    const binary = describeBinary(buf);
    if (binary) {
      throw new CsvFormatError(
        `Import failed — file could not be read. "${filename}" is ${binary.what}. ${binary.fix}`,
        'not_text');
    }
  }

  const text = stripBom(buf ? buf.toString('utf8') : String(pasted));
  if (!text.trim()) {
    throw new CsvFormatError(`Import failed — "${filename}" contains no text.`, 'empty_file');
  }

  const { headers, records } = parseCsvObjects(text);
  if (headers.length === 0) {
    throw new CsvFormatError(
      `Import failed — no rows found in file. "${filename}" has no header row.`, 'no_header');
  }

  for (const alternatives of requireColumns) {
    // Headers are compared lower-cased, so an entry may be written the way the
    // admin sees it in the template ("Item Name") and still match "item name".
    const names = Array.isArray(alternatives) ? alternatives : [alternatives];
    if (names.some((n) => headers.includes(n.trim().toLowerCase()))) continue;
    throw new CsvFormatError(
      `Import failed — required column '${names[0]}' is missing. ` +
      `Columns found: ${headers.join(', ')}.`,
      'missing_column');
  }

  if (records.length === 0) {
    throw new CsvFormatError(
      `Import failed — no rows found in file. "${filename}" has a header row but no data rows.`,
      'no_rows');
  }

  return { text, filename, headers, records };
}
