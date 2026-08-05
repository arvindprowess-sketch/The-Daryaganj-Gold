import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, rootDir } from '../config.js';

// ── Storage interface ───────────────────────────────────────────────────────
// save(buffer, { ext, contentType, name }) -> { url, key }
//
// Image FILES live in object storage; the database only ever holds the public
// URL string. Never store binary or base64 image data in Postgres.
//
// A single narrow interface so the local disk driver used in dev can be swapped
// for an S3/R2 driver in production by changing environment variables only.

// Slugify an item name for use in a filename: ascii-ish, lowercase, hyphenated.
export function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'photo';
}

// Unique object key: date folder / item-name-slug + short random hash.
// The hash guarantees two uploads for the same item never collide.
function buildKey(ext, name) {
  const stamp = new Date().toISOString().slice(0, 10);
  const hash = crypto.randomBytes(4).toString('hex'); // 8 chars
  return `${stamp}/${slugify(name)}-${hash}${ext || ''}`;
}

// Recovers the storage key from a stored URL, so a deleted row's photo can be
// removed from the bucket. Returns null for anything that is not ours.
export function keyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const bases = [
    `${config.publicBaseUrl}/uploads/`,
    '/uploads/',
    config.s3.publicBaseUrl ? `${config.s3.publicBaseUrl.replace(/\/+$/, '')}/` : null,
    config.s3.endpoint && config.s3.bucket
      ? `${config.s3.endpoint.replace(/\/+$/, '')}/${config.s3.bucket}/`
      : null,
  ].filter(Boolean);
  for (const base of bases) {
    const idx = url.indexOf(base);
    if (idx !== -1) return url.slice(idx + base.length);
  }
  return null;
}

// ── Local disk driver ───────────────────────────────────────────────────────
const localDriver = {
  async save(buffer, { ext, name } = {}) {
    const key = buildKey(ext, name);
    const full = path.join(rootDir, config.uploadDir, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    return { key, url: `${config.publicBaseUrl}/uploads/${key}` };
  },

  // Best-effort: a missing object is not an error. Never throws, so storage
  // cleanup can never roll back an already-committed database change.
  async remove(key) {
    if (!key) return false;
    try {
      const full = path.join(rootDir, config.uploadDir, key);
      // Refuse to escape the upload directory.
      const root = path.resolve(rootDir, config.uploadDir);
      if (!path.resolve(full).startsWith(root)) return false;
      fs.rmSync(full, { force: true });
      return true;
    } catch { return false; }
  },
};

// ── S3 / R2 driver (S3-compatible) ─────────────────────────────────────────
function makeS3Driver() {
  // Imported lazily so dev installs don't need the SDK configured to run.
  let clientPromise;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => ({
        S3Client,
        client: new S3Client({
          endpoint: config.s3.endpoint || undefined,
          region: config.s3.region,
          forcePathStyle: config.s3.forcePathStyle,
          credentials: {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey,
          },
        }),
      }));
    }
    return clientPromise;
  }

  return {
    async save(buffer, { ext, contentType, name } = {}) {
      const { client } = await getClient();
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const key = buildKey(ext, name);
      await client.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType || 'application/octet-stream',
        })
      );
      const base =
        config.s3.publicBaseUrl ||
        `${config.s3.endpoint}/${config.s3.bucket}`.replace(/\/+$/, '');
      return { key, url: `${base}/${key}` };
    },

    async remove(key) {
      if (!key) return false;
      try {
        const { client } = await getClient();
        const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
        return true;
      } catch { return false; }
    },
  };
}

export const storage =
  config.storageDriver === 's3' ? makeS3Driver() : localDriver;

// Removes photos for a set of stored URLs. Called ONLY after the database
// transaction has committed, so a storage failure can never orphan a row.
// Returns the number successfully removed.
export async function removePhotos(urls = []) {
  let removed = 0;
  for (const url of urls) {
    const key = keyFromUrl(url);
    if (!key) continue;
    if (await storage.remove(key)) removed++;
  }
  return removed;
}
