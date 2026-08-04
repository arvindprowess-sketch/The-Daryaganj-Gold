import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth.js';
import { storage } from '../lib/storage.js';

const router = Router();

const ALLOWED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB raw; client should compress first
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  },
});

// Accepts a single image, compresses to max 1200px long edge (safety net on top
// of client-side compression), stores it, and returns the URL only.
router.post('/', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const buffer = await sharp(req.file.buffer)
      .rotate() // respect EXIF orientation
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    const { url } = await storage.save(buffer, { ext: '.jpg', contentType: 'image/jpeg' });
    res.status(201).json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Upload failed' });
  }
});

export default router;
