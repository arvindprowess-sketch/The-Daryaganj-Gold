import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { storage } from '../lib/storage.js';
import { toCsv } from '../lib/csvTemplate.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── CSV template download ───────────────────────────────────────────────────
// Placed before /:id-style routes. A real .csv with headers + sample rows.
router.get('/import/template', requireRole('admin'), (_req, res) => {
  const csv = toCsv(
    ['name', 'section', 'category', 'unit', 'is_liquor', 'bottle_size_ml', 'rate'],
    [
      ['Refined Oil', 'Main Store / Backroom', 'Dry Store', 'Ltr', 'no', '', '140'],
      ['Paneer', 'Base Kitchen', 'Vegetables & Dairy', 'Kg', 'no', '', '320'],
      ['Old Monk Rum', 'Bar & Liquor', 'Spirits', 'Bottle', 'yes', '750', '750'],
    ]
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="item_master_template.csv"');
  res.send(csv);
});

// ── List items (admin only — carries rate) ──────────────────────────────────
router.get('/', requireRole('admin'), async (req, res) => {
  const { search, section_id, category_id } = req.query;
  const conds = [];
  const params = [];
  if (search) { params.push(`%${search}%`); conds.push(`i.name ILIKE $${params.length}`); }
  if (section_id) { params.push(section_id); conds.push(`i.section_id = $${params.length}`); }
  if (category_id) { params.push(category_id); conds.push(`i.category_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT i.*, c.name AS category_name, s.name AS section_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN sections s ON s.id = i.section_id
       ${where}
       ORDER BY i.name`,
    params
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const name = normalizeName(b.name);
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      `INSERT INTO items (name, category_id, section_id, unit, is_liquor, bottle_size_ml, rate, photo_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE)) RETURNING *`,
      [name, b.category_id || null, b.section_id || null, b.unit || 'Nos',
       !!b.is_liquor, b.bottle_size_ml || null, b.rate ?? null, b.photo_url || null, b.is_active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An item with this name already exists' });
    throw err;
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const name = b.name !== undefined ? normalizeName(b.name) : null;
  try {
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
         photo_version = CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM photo_url
                              THEN photo_version + 1 ELSE photo_version END,
         is_active = COALESCE($10, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, b.category_id, b.section_id, b.unit, b.is_liquor,
       b.bottle_size_ml ?? null, b.rate, b.photo_url, b.is_active]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An item with this name already exists' });
    throw err;
  }
});

// ── CSV import ──────────────────────────────────────────────────────────────
// Rows are matched to existing items by normalized name. A row whose name does
// not match is NOT silently created or skipped — it is returned in `unmatched`
// so the admin decides per row: create as new item, or skip.
async function analyseCsv(records) {
  const { rows: sections } = await query('SELECT id, name FROM sections');
  const { rows: cats } = await query('SELECT id, name FROM categories');
  const sectionByName = new Map(sections.map((s) => [nameKey(s.name), s.id]));
  const catByName = new Map(cats.map((c) => [nameKey(c.name), c.id]));
  const { rows: existing } = await query('SELECT id, name FROM items');
  const existingByName = new Map(existing.map((e) => [nameKey(e.name), e.id]));

  const seen = new Set();
  return records.map((r, idx) => {
    const errors = [];
    const name = normalizeName(r.name);
    if (!name) errors.push('name is required');
    const key = nameKey(name);
    if (name && seen.has(key)) errors.push('duplicate name within file');
    seen.add(key);

    const sectionId = r.section ? sectionByName.get(nameKey(r.section)) : null;
    const categoryId = r.category ? catByName.get(nameKey(r.category)) : null;
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

    const existingId = existingByName.get(key) || null;
    return {
      row: idx + 2, // 1-based + header line
      data: { name, section_id: sectionId || null, category_id: categoryId || null,
              unit: (r.unit || 'Nos').trim() || 'Nos', is_liquor: isLiquor,
              bottle_size_ml: bottleSize, rate },
      matched: !!existingId,
      existingId,
      errors,
    };
  });
}

router.post('/import/preview', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { headers, records } = parseCsvObjects(text);
  if (!headers.includes('name')) {
    return res.status(400).json({ error: 'Missing required column: name' });
  }
  const rows = await analyseCsv(records);
  res.json({
    total: rows.length,
    matched: rows.filter((r) => r.matched && !r.errors.length).length,
    unmatched: rows.filter((r) => !r.matched && !r.errors.length).length,
    invalid: rows.filter((r) => r.errors.length > 0).length,
    rows,
  });
});

// Commit. `decisions` maps row number -> 'create' | 'skip' for unmatched rows.
// Unmatched rows with no decision are skipped (never silently created).
router.post('/import/commit', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  let decisions = {};
  try {
    decisions = typeof req.body?.decisions === 'string'
      ? JSON.parse(req.body.decisions) : (req.body?.decisions || {});
  } catch { decisions = {}; }

  const { records } = parseCsvObjects(text);
  const rows = await analyseCsv(records);
  const bad = rows.filter((r) => r.errors.length > 0);
  if (bad.length) return res.status(400).json({ error: 'Fix errors before committing', rows: bad });

  const result = await withTransaction(async (c) => {
    let updated = 0, created = 0, skipped = 0;
    for (const r of rows) {
      const d = r.data;
      if (r.matched) {
        await c.query(
          `UPDATE items SET name=$2, category_id=$3, section_id=$4, unit=$5,
                            is_liquor=$6, bottle_size_ml=$7, rate=$8
             WHERE id=$1`,
          [r.existingId, d.name, d.category_id, d.section_id, d.unit, d.is_liquor, d.bottle_size_ml, d.rate]
        );
        updated++;
      } else if (decisions[r.row] === 'create') {
        await c.query(
          `INSERT INTO items (name, category_id, section_id, unit, is_liquor, bottle_size_ml, rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (lower(name)) DO NOTHING`,
          [d.name, d.category_id, d.section_id, d.unit, d.is_liquor, d.bottle_size_ml, d.rate]
        );
        created++;
      } else {
        skipped++;
      }
    }
    return { updated, created, skipped };
  });
  res.json({ ok: true, ...result });
});

// ── Bulk photo upload: match filename to item NAME ──────────────────────────
// e.g. "Refined Oil.jpg" → item "Refined Oil" (trim / collapse spaces /
// case-insensitive). Admin uploads set the master photo directly.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 200 } });

router.post('/photos/bulk', requireRole('admin'), photoUpload.array('photos', 200), async (req, res) => {
  const files = req.files || [];
  const matched = [];
  const unmatched = [];
  for (const f of files) {
    const base = f.originalname.replace(/\.[^.]+$/, '');
    const { rows } = await query('SELECT id, name FROM items WHERE lower(name) = $1', [nameKey(base)]);
    if (!rows[0]) { unmatched.push(f.originalname); continue; }
    try {
      const buf = await sharp(f.buffer).rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 }).toBuffer();
      const { url } = await storage.save(buf, {
        ext: '.jpg', contentType: 'image/jpeg', name: rows[0].name,
      });
      await query('UPDATE items SET photo_url = $2, photo_version = photo_version + 1 WHERE id = $1',
        [rows[0].id, url]);
      matched.push({ name: rows[0].name, url });
    } catch {
      unmatched.push(f.originalname);
    }
  }
  res.json({ matched: matched.length, unmatched, details: matched });
});

export default router;
