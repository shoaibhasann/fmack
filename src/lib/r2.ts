import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import path from 'path';

export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_PUBLIC_URL
  );
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

export async function uploadToR2(
  buffer: Buffer,
  folder: string,
  originalName: string,
  contentType: string
): Promise<string> {
  if (!isR2Configured()) throw new Error('R2 not configured — add R2_* vars to .env');
  const ext = path.extname(originalName).toLowerCase() || '.png';
  const key = `${folder}/${randomUUID()}${ext}`;
  await getClient().send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME!,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

export async function deleteFromR2(url: string): Promise<void> {
  if (!isR2Configured() || !url) return;
  const base = process.env.R2_PUBLIC_URL!.replace(/\/$/, '');
  const key  = url.replace(`${base}/`, '');
  await getClient().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key:    key,
  }));
}
