import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects } from '../lib/csv.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── List items (admin: full; auditor: rate stripped by blind-count wrapper) ──
// Admin-facing item master. Auditors do NOT use this endpoint for counting —
// they use the audit item list which is blind-count filtered. Restricted to
// admin to keep rate out of reach entirely.
router.get('/', requireRole('admin'), async (req, res) => {
  const { search, section_id, category_id } = req.query;
  const conds = [];
  const params = [];
  if (search) { params.push(`%${search}%`); conds.push(`(i.name ILIKE $${params.length} OR i.code ILIKE $${params.length})`); }
  if (section_id) { params.push(section_id); conds.push(`i.section_id = $${params.length}`); }
  if (category_id) { params.push(category_id); conds.push(`i.category_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT i.*, c.name AS category_name, s.name AS section_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN sections s ON s.id = i.section_id
       ${where}
       ORDER BY i.code`,
    params
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'code and name required' });
  try {
    const { rows } = await query(
      `INSERT INTO items (code, name, category_id, section_id, unit, is_liquor, bottle_size_ml, rate, photo_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, TRUE)) RETURNING *`,
      [b.code, b.name, b.category_id || null, b.section_id || null, b.unit || 'Nos',
       !!b.is_liquor, b.bottle_size_ml || null, b.rate ?? null, b.photo_url || null, b.is_active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Item code exists' });
    throw err;
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE items SET
       name = COALESCE($2, name),
       category_id = COALESCE($3, category_id),
       section_id = COALESCE($4, section_id),
       unit = COALESCE($5, unit),
       is_liquor = COALESCE($6, is_liquor),
       bottle_size_ml = $7,
       rate = COALESCE($8, rate),
       photo_url = COALESCE($9, photo_url),
       is_active = COALESCE($10, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name, b.category_id, b.section_id, b.unit, b.is_liquor,
     b.bottle_size_ml ?? null, b.rate, b.photo_url, b.is_active]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ── CSV import: validate rows, return preview with row-level errors ──────────
async function validateCsv(records) {
  const { rows: sections } = await query('SELECT id, lower(name) AS name FROM sections');
  const { rows: cats } = await query('SELECT id, lower(name) AS name FROM categories');
  const sectionByName = new Map(sections.map((s) => [s.name, s.id]));
  const catByName = new Map(cats.map((c) => [c.name, c.id]));
  const { rows: existing } = await query('SELECT lower(code) AS code FROM items');
  const existingCodes = new Set(existing.map((e) => e.code));

  const seen = new Set();
  return records.map((r, idx) => {
    const errors = [];
    const code = (r.code || '').trim();
    const name = (r.name || '').trim();
    if (!code) errors.push('code is required');
    if (!name) errors.push('name is required');
    if (code && seen.has(code.toLowerCase())) errors.push('duplicate code within file');
    seen.add(code.toLowerCase());

    const sectionId = r.section ? sectionByName.get(r.section.toLowerCase()) : null;
    const categoryId = r.category ? catByName.get(r.category.toLowerCase()) : null;
    if (r.section && !sectionId) errors.push(`unknown section "${r.section}"`);
    if (r.category && !categoryId) errors.push(`unknown category "${r.category}"`);

    const isLiquor = /^(1|true|yes|y)$/i.test((r.is_liquor || '').trim());
    let bottleSize = null;
    if (r.bottle_size_ml && r.bottle_size_ml.trim() !== '') {
      bottleSize = parseInt(r.bottle_size_ml, 10);
      if (Number.isNaN(bottleSize)) errors.push('bottle_size_ml must be a number');
    }
    if (isLiquor && !bottleSize) errors.push('liquor items need bottle_size_ml');

    let rate = null;
    if (r.rate && r.rate.trim() !== '') {
      rate = parseFloat(r.rate);
      if (Number.isNaN(rate)) errors.push('rate must be a number');
    }

    return {
      row: idx + 2, // +2: 1-based + header line
      data: { code, name, section_id: sectionId || null, category_id: categoryId || null,
              unit: (r.unit || 'Nos').trim() || 'Nos', is_liquor: isLiquor,
              bottle_size_ml: bottleSize, rate },
      isNew: !existingCodes.has(code.toLowerCase()),
      errors,
    };
  });
}

router.post('/import/preview', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { headers, records } = parseCsvObjects(text);
  const required = ['code', 'name'];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length) return res.status(400).json({ error: `Missing columns: ${missing.join(', ')}` });
  const preview = await validateCsv(records);
  res.json({
    total: preview.length,
    valid: preview.filter((p) => p.errors.length === 0).length,
    invalid: preview.filter((p) => p.errors.length > 0).length,
    rows: preview,
  });
});

// Commit: upsert only valid rows. Aborts entirely if any row has an error.
router.post('/import/commit', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { records } = parseCsvObjects(text);
  const preview = await validateCsv(records);
  const bad = preview.filter((p) => p.errors.length > 0);
  if (bad.length) return res.status(400).json({ error: 'Fix errors before committing', rows: bad });

  const result = await withTransaction(async (c) => {
    let inserted = 0, updated = 0;
    for (const p of preview) {
      const d = p.data;
      const r = await c.query(
        `INSERT INTO items (code, name, category_id, section_id, unit, is_liquor, bottle_size_ml, rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, category_id = EXCLUDED.category_id,
           section_id = EXCLUDED.section_id, unit = EXCLUDED.unit,
           is_liquor = EXCLUDED.is_liquor, bottle_size_ml = EXCLUDED.bottle_size_ml,
           rate = EXCLUDED.rate
         RETURNING (xmax = 0) AS inserted`,
        [d.code, d.name, d.category_id, d.section_id, d.unit, d.is_liquor, d.bottle_size_ml, d.rate]
      );
      if (r.rows[0].inserted) inserted++; else updated++;
    }
    return { inserted, updated };
  });
  res.json({ ok: true, ...result });
});

// ── Bulk photo upload: match filename (DRY-001.jpg) to item code ─────────────
import sharp from 'sharp';
import { storage } from '../lib/storage.js';
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 200 } });

router.post('/photos/bulk', requireRole('admin'), photoUpload.array('photos', 200), async (req, res) => {
  const files = req.files || [];
  const matched = [];
  const unmatched = [];
  for (const f of files) {
    const code = f.originalname.replace(/\.[^.]+$/, '').trim();
    const { rows } = await query('SELECT id FROM items WHERE lower(code) = lower($1)', [code]);
    if (!rows[0]) { unmatched.push(f.originalname); continue; }
    try {
      const buf = await sharp(f.buffer).rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 }).toBuffer();
      const { url } = await storage.save(buf, { ext: '.jpg', contentType: 'image/jpeg' });
      await query('UPDATE items SET photo_url = $2 WHERE id = $1', [rows[0].id, url]);
      matched.push({ code, url });
    } catch {
      unmatched.push(f.originalname);
    }
  }
  res.json({ matched: matched.length, unmatched, details: matched });
});

export default router;
