import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, rootDir } from '../config.js';

// ── Storage interface ───────────────────────────────────────────────────────
// save(buffer, { ext, contentType }) -> { url, key }
// A single narrow interface so the local disk driver used in dev can be swapped
// for an S3/R2 driver in production with no route changes.

function randomKey(ext) {
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(8).toString('hex');
  return `${stamp}/${rand}${ext || ''}`;
}

// ── Local disk driver ───────────────────────────────────────────────────────
const localDriver = {
  async save(buffer, { ext } = {}) {
    const key = randomKey(ext);
    const full = path.join(rootDir, config.uploadDir, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    return { key, url: `${config.publicBaseUrl}/uploads/${key}` };
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
    async save(buffer, { ext, contentType } = {}) {
      const { client } = await getClient();
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const key = randomKey(ext);
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
  };
}

export const storage =
  config.storageDriver === 's3' ? makeS3Driver() : localDriver;
