import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseCsvObjects } from '../lib/csv.js';
import { normalizeName, nameKey } from '../lib/itemName.js';
import { storage, removePhotos } from '../lib/storage.js';
import { toCsv } from '../lib/csvTemplate.js';
import { logActivity } from '../lib/activityLog.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── CSV template download ───────────────────────────────────────────────────
// Placed before /:id-style routes. A real .csv with headers + sample rows.
router.get('/import/template', requireRole('admin'), (_req, res) => {
  // Unit is free text — whatever the client's master says, character for
  // character. The samples below show two non-liquor rows and one liquor row.
  const csv = toCsv(
    ['item_name', 'super_category', 'category', 'unit', 'is_liquor', 'bottle_size_ml', 'rate'],
    [
      ['Refined Oil', 'FOOD', 'PROVISION', 'CAN (5 LTR)', 'FALSE', '', '140'],
      ['Paneer', 'FOOD', 'DAIRY', 'TIN (850 GM)', 'FALSE', '', '320'],
      ['Old Monk Rum', 'LIQUOR', 'LIQUOR', 'BTL (750 ML)', 'TRUE', '750', '750'],
    ]
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="item_master_template.csv"');
  res.send(csv);
});

// ── List items (admin only — carries rate) ──────────────────────────────────
router.get('/', requireRole('admin'), async (req, res) => {
  const { search, super_category_id, category_id, photo } = req.query;
  // [Active] [Inactive] [All] — inactive items are soft-deleted ones, kept so
  // historical audit records are never orphaned.
  const active = ['inactive', 'all'].includes(req.query.active) ? req.query.active : 'active';
  const conds = [];
  if (active === 'active') conds.push('i.is_active = TRUE');
  else if (active === 'inactive') conds.push('i.is_active = FALSE');
  const params = [];
  if (search) { params.push(`%${search}%`); conds.push(`i.name ILIKE $${params.length}`); }
  if (super_category_id) { params.push(super_category_id); conds.push(`i.super_category_id = $${params.length}`); }
  if (category_id) { params.push(category_id); conds.push(`i.category_id = $${params.length}`); }
  // Photo coverage filter — with 618 items and photos collected during the
  // pilot, the admin needs to see at a glance what is still missing.
  if (photo === 'has') conds.push('i.photo_url IS NOT NULL');
  else if (photo === 'none') conds.push('i.photo_url IS NULL');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT i.*, c.name AS category_name, sc.name AS super_category_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN super_categories sc ON sc.id = i.super_category_id
       ${where}
       ORDER BY sc.sort_order NULLS LAST, sc.name, c.name, i.name`,
    params
  );
  // Header counts are over the whole master, not the filtered page.
  const { rows: totals } = await query(
    `SELECT COUNT(*) FILTER (WHERE is_active)::int AS total,
            COUNT(photo_url) FILTER (WHERE is_active)::int AS with_photo,
            COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
            COUNT(*)::int AS all_items
       FROM items`
  );
  res.json({ items: rows, counts: totals[0] });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const name = normalizeName(b.name);
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      `INSERT INTO items (name, category_id, super_category_id, unit, is_liquor, bottle_size_ml, rate, photo_url, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE)) RETURNING *`,
      // Unit is stored exactly as given (only outer whitespace trimmed).
      [name, b.category_id || null, b.super_category_id || null, (b.unit ?? '').trim(),
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
         super_category_id = COALESCE($4, super_category_id),
         unit = COALESCE($5, unit),
         is_liquor = COALESCE($6, is_liquor),
         bottle_size_ml = $7,
         rate = COALESCE($8, rate),
         photo_url = COALESCE($9, photo_url),
         photo_version = CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM photo_url
                              THEN photo_version + 1 ELSE photo_version END,
         is_active = COALESCE($10, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, b.category_id, b.super_category_id,
       b.unit === undefined ? null : String(b.unit).trim(), b.is_liquor,
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
// is_liquor accepts TRUE/FALSE, true/false, 1/0, Yes/No (any case).
function parseBool(v) {
  const s = String(v ?? '').trim();
  if (/^(1|true|yes|y)$/i.test(s)) return true;
  if (/^(0|false|no|n|)$/i.test(s)) return false;
  return null; // unrecognised
}

async function analyseCsv(records) {
  const { rows: supers } = await query('SELECT id, name FROM super_categories');
  const { rows: cats } = await query(
    'SELECT id, name, super_category_id FROM categories'
  );
  const superByName = new Map(supers.map((s) => [nameKey(s.name), s.id]));
  // Categories are keyed per super category, since a name may repeat.
  const catBySuperAndName = new Map(
    cats.map((c) => [`${c.super_category_id}|${nameKey(c.name)}`, c.id])
  );
  const { rows: existing } = await query('SELECT id, name FROM items');
  const existingByName = new Map(existing.map((e) => [nameKey(e.name), e.id]));

  // Track hierarchy levels the file introduces so the preview can report them
  // as "new — will be created" rather than failing the import.
  const newSupers = new Set();
  const newCats = new Set();

  const seen = new Set();
  const rows = records.map((r, idx) => {
    const errors = [];
    // Accept item_name (current) and name (legacy) as the identifier column.
    const name = normalizeName(r.item_name ?? r.name);
    if (!name) errors.push('item_name is required');
    const key = nameKey(name);
    if (name && seen.has(key)) errors.push('duplicate item_name within file');
    seen.add(key);

    const superName = (r.super_category || '').trim();
    const catName = (r.category || '').trim();
    const superId = superName ? superByName.get(nameKey(superName)) ?? null : null;
    const superIsNew = !!superName && !superId;
    if (superIsNew) newSupers.add(superName);

    // A category can only resolve once its super category exists.
    const catId = catName && superId
      ? catBySuperAndName.get(`${superId}|${nameKey(catName)}`) ?? null
      : null;
    const catIsNew = !!catName && !catId;
    if (catIsNew) newCats.add(`${superName}/${catName}`);

    const isLiquorRaw = parseBool(r.is_liquor);
    if (isLiquorRaw === null) errors.push(`is_liquor "${r.is_liquor}" not recognised (use TRUE/FALSE, 1/0, Yes/No)`);
    const isLiquor = isLiquorRaw === true;

    let bottleSize = null;
    const bsRaw = (r.bottle_size_ml ?? '').toString().trim();
    if (bsRaw !== '') {
      bottleSize = parseInt(bsRaw, 10);
      if (Number.isNaN(bottleSize)) errors.push('bottle_size_ml must be a number');
    }
    if (isLiquor && !bottleSize) errors.push('bottle_size_ml is required when is_liquor is TRUE');

    let rate = null;
    const rateRaw = (r.rate ?? '').toString().trim();
    if (rateRaw !== '') {
      rate = parseFloat(rateRaw);
      if (Number.isNaN(rate)) errors.push('rate must be a number');
    }

    const existingId = existingByName.get(key) || null;
    return {
      row: idx + 2, // 1-based + header line
      data: {
        name,
        super_category_id: superId,
        category_id: catId,
        // Unit is free text taken verbatim — no dropdown, no reference table,
        // no normalisation. An unrecognised unit NEVER rejects a row.
        unit: (r.unit ?? '').trim(),
        super_category_name: superName,
        category_name: catName,
        is_liquor: isLiquor,
        bottle_size_ml: bottleSize,
        rate,
      },
      matched: !!existingId,
      existingId,
      newSuperCategory: superIsNew,
      newCategory: catIsNew,
      errors,
    };
  });

  return { rows, newSupers: [...newSupers], newCats: [...newCats] };
}

router.post('/import/preview', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const { headers, records } = parseCsvObjects(text);
  if (!headers.includes('item_name') && !headers.includes('name')) {
    return res.status(400).json({ error: 'Missing required column: item_name' });
  }
  const { rows, newSupers, newCats } = await analyseCsv(records);
  res.json({
    total: rows.length,
    matched: rows.filter((r) => r.matched && !r.errors.length).length,
    unmatched: rows.filter((r) => !r.matched && !r.errors.length).length,
    invalid: rows.filter((r) => r.errors.length > 0).length,
    // Hierarchy levels the file introduces. These do NOT fail the import —
    // they are created on commit.
    newSuperCategories: newSupers,
    newCategories: newCats,
    rows,
    // Impact per import mode, so the screen can state plainly what will happen.
    modes: await importModeImpact(rows),
  });
});

// ── Import modes ───────────────────────────────────────────────────────────
//   add        — add new items only; existing items untouched
//   upsert     — add new AND update existing (matched by item name)
//   replace    — delete the entire master, then import
// An item is NEVER deleted silently as a side effect of an import: only the
// explicit `replace` mode removes anything, and it carries its own guards.
const IMPORT_MODES = ['add', 'upsert', 'replace'];
const REPLACE_PHRASE = 'REPLACE ITEM MASTER';

async function importModeImpact(rows) {
  const valid = rows.filter((r) => r.errors.length === 0);
  const matched = valid.filter((r) => r.matched).length;
  const unmatched = valid.filter((r) => !r.matched).length;
  const { rows: t } = await query(
    `SELECT (SELECT count(*)::int FROM items) AS total_items,
            (SELECT count(*)::int FROM count_entries) AS entries,
            (SELECT count(DISTINCT audit_id)::int FROM count_entries) AS audits`
  );
  const { total_items: totalItems, entries, audits } = t[0];
  return {
    add:     { created: unmatched, updated: 0, deleted: 0 },
    upsert:  { created: unmatched, updated: matched, deleted: 0 },
    replace: {
      created: valid.length, updated: 0, deleted: totalItems,
      // Same rule as "delete all items": blocked while any count entry exists.
      blocked: entries > 0,
      blockedReason: entries > 0
        ? `Cannot replace. ${entries.toLocaleString()} count entries exist across ${audits} audit(s). Delete or archive those audits first.`
        : null,
      requiredPhrase: REPLACE_PHRASE,
    },
  };
}

// Commit. `mode` selects add / upsert / replace (see IMPORT_MODES).
// In `add` mode `decisions` maps row number -> 'create' | 'skip' for unmatched
// rows; unmatched rows with no decision are skipped, never silently created.
router.post('/import/commit', requireRole('admin'), upload.single('file'), async (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : req.body?.csv;
  if (!text) return res.status(400).json({ error: 'No CSV provided' });
  const mode = IMPORT_MODES.includes(req.body?.mode) ? req.body.mode : 'add';
  let decisions = {};
  try {
    decisions = typeof req.body?.decisions === 'string'
      ? JSON.parse(req.body.decisions) : (req.body?.decisions || {});
  } catch { decisions = {}; }

  const { records } = parseCsvObjects(text);
  const { rows } = await analyseCsv(records);
  const bad = rows.filter((r) => r.errors.length > 0);
  if (bad.length) return res.status(400).json({ error: 'Fix errors before committing', rows: bad });

  // ── `replace` carries the same guards as "delete all items" ──────────────
  let photoUrls = [];
  if (mode === 'replace') {
    const { rows: chk } = await query(
      `SELECT (SELECT count(*)::int FROM count_entries) AS entries,
              (SELECT count(DISTINCT audit_id)::int FROM count_entries) AS audits`
    );
    if (chk[0].entries > 0) {
      return res.status(409).json({
        error: `Cannot replace. ${chk[0].entries.toLocaleString()} count entries exist across ${chk[0].audits} audit(s). Delete or archive those audits first.`,
        blocked: true, entries: chk[0].entries, audits: chk[0].audits,
      });
    }
    if ((req.body?.confirm || '').trim().toUpperCase() !== REPLACE_PHRASE) {
      return res.status(400).json({
        error: `Type "${REPLACE_PHRASE}" to confirm`, requiredPhrase: REPLACE_PHRASE,
      });
    }
    const { rows: ph } = await query(
      'SELECT photo_url FROM items WHERE photo_url IS NOT NULL');
    photoUrls = ph.map((x) => x.photo_url);
  }

  const result = await withTransaction(async (c) => {
    let updated = 0, created = 0, skipped = 0, deleted = 0;
    const createdSupers = new Set();
    const createdCats = new Set();

    // Resolve (creating if needed) the super category / category for a row.
    // A hierarchy level named in the file but absent from the database is
    // CREATED here — it never fails the import.
    async function resolveHierarchy(d) {
      let superId = d.super_category_id;
      if (!superId && d.super_category_name) {
        const { rows: sr } = await c.query(
          `INSERT INTO super_categories (name, sort_order)
           VALUES ($1, 99)
           ON CONFLICT (lower(name)) DO UPDATE SET name = super_categories.name
           RETURNING id`,
          [d.super_category_name]
        );
        superId = sr[0].id;
        createdSupers.add(d.super_category_name);
      }
      let catId = d.category_id;
      if (!catId && d.category_name) {
        const { rows: cr } = await c.query(
          `INSERT INTO categories (name, super_category_id)
           VALUES ($1, $2)
           ON CONFLICT (super_category_id, lower(name)) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [d.category_name, superId]
        );
        catId = cr[0].id;
        createdCats.add(`${d.super_category_name}/${d.category_name}`);
      }
      return { superId, catId };
    }

    // Replace mode: clear the master first, inside this same transaction, so a
    // failure cannot leave the audit with a half-deleted master.
    if (mode === 'replace') {
      await c.query('DELETE FROM system_stock');
      await c.query('DELETE FROM photo_reviews');
      await c.query('DELETE FROM audit_na');
      deleted = (await c.query('DELETE FROM items')).rowCount;
    }

    for (const r of rows) {
      const d = r.data;
      // `add` only creates what the admin chose; `upsert` updates matches and
      // creates the rest; `replace` re-inserts everything after the wipe above.
      // An existing item is never deleted as a side effect of an import.
      if (mode === 'add' && r.matched) { skipped++; continue; }
      if (mode === 'add' && !r.matched && decisions[r.row] !== 'create') { skipped++; continue; }

      const { superId, catId } = await resolveHierarchy(d);

      if (r.matched && mode === 'upsert') {
        await c.query(
          `UPDATE items SET name=$2, category_id=$3, super_category_id=$4, unit=$5,
                            is_liquor=$6, bottle_size_ml=$7, rate=$8
             WHERE id=$1`,
          [r.existingId, d.name, catId, superId, d.unit, d.is_liquor, d.bottle_size_ml, d.rate]
        );
        updated++;
      } else {
        await c.query(
          `INSERT INTO items (name, category_id, super_category_id, unit, is_liquor, bottle_size_ml, rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (lower(name)) DO NOTHING`,
          [d.name, catId, superId, d.unit, d.is_liquor, d.bottle_size_ml, d.rate]
        );
        created++;
      }
    }

    await logActivity({
      entityType: 'item_master', action: `import_${mode}`,
      recordCount: created + updated,
      detail: { mode, created, updated, deleted, skipped,
                filename: req.file?.originalname || 'pasted-data.csv' },
      userId: req.user.id,
    }, c);
    return {
      updated, created, skipped, deleted,
      createdSuperCategories: [...createdSupers],
      createdCategories: [...createdCats],
    };
  });

  // Orphaned photos are removed only after the transaction has committed.
  const photosRemoved = photoUrls.length ? await removePhotos(photoUrls) : 0;
  res.json({ ok: true, mode, photosRemoved, ...result });
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
