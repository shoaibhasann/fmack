import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import path           from 'path';

// Returns true only when all five R2 env vars are set
export function isR2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_PUBLIC_URL
  );
}

// Lazy-initialised S3 client — created on first use
let _client = null;
function getClient() {
  if (_client) return _client;
  _client = new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

// Upload a buffer and return the public CDN URL
export async function uploadToR2(buffer, folder, originalName, contentType) {
  if (!isR2Configured()) {
    throw new Error('R2 is not configured. Add R2_* variables to your .env file.');
  }
  const ext = path.extname(originalName).toLowerCase() || '.png';
  const key = `${folder}/${randomUUID()}${ext}`;

  await getClient().send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         key,
    Body:        buffer,
    ContentType: contentType || 'image/jpeg',
  }));

  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// Delete a file from R2 by its full CDN URL. Safe to call if R2 not configured.
export async function deleteFromR2(url) {
  if (!isR2Configured() || !url) return;
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  const key  = url.replace(`${base}/`, '');
  await getClient().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key:    key,
  }));
}
