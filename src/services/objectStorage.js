const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sdk = require('@aws-sdk/client-s3');
const presigner = require('@aws-sdk/s3-request-presigner');

const enabled = () => process.env.OBJECT_STORAGE_ENABLED === 'true';
function config() {
  if (!enabled()) throw new Error('Object storage disabled');
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('Object storage configuration incomplete');
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT || undefined;
  if (endpoint && new URL(endpoint).protocol !== 'https:') throw new Error('Object storage requires HTTPS');
  return { bucket, options: { endpoint, region: process.env.OBJECT_STORAGE_REGION || 'auto',
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3,
    requestHandler: { connectionTimeout:10000, requestTimeout:120000 },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' } };
}
function ttl() {
  const seconds = Number(process.env.MEDIA_SIGNED_URL_TTL_SECONDS || 900);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error('Media URL TTL must be 60..3600 seconds');
  return seconds;
}
const contentType = filename => ({ '.mp4':'video/mp4', '.mov':'video/quicktime', '.avi':'video/x-msvideo',
  '.mkv':'video/x-matroska', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.gif':'image/gif' }[path.extname(filename).toLowerCase()] || 'application/octet-stream');
function key(kind, filename) {
  if (!['video','image'].includes(kind)) throw new Error('Invalid media kind');
  return `lessons/${kind}/${randomUUID()}${path.extname(filename).toLowerCase()}`;
}
function validKey(value) {
  return typeof value === 'string' && /^lessons\/(video|image)\/[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(value);
}
async function command(Command, input) {
  const { bucket, options } = config();
  const client = new sdk.S3Client(options);
  try { return await client.send(new Command({ Bucket: bucket, ...input })); }
  catch (_) { throw new Error('Object storage operation failed'); }
  finally { client.destroy(); }
}
async function upload(filePath, objectKey) {
  if (!validKey(objectKey)) throw new Error('Invalid object key');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Media must be a file');
  const body = fs.createReadStream(filePath);
  try {
    await command(sdk.PutObjectCommand, { Key: objectKey, Body: body, ContentLength: stat.size,
      ContentType: contentType(filePath), CacheControl: 'private, max-age=900' });
    await verify(objectKey, stat.size);
  } finally { body.destroy(); }
}
async function verify(objectKey, expectedSize) {
  if (!validKey(objectKey)) throw new Error('Invalid object key');
  const result = await command(sdk.HeadObjectCommand, { Key: objectKey });
  if (expectedSize !== undefined && Number(result.ContentLength) !== expectedSize) throw new Error('Object size verification failed');
}
async function signedGet(objectKey) {
  if (!validKey(objectKey)) throw new Error('Invalid object key');
  const { bucket, options } = config(), expiresIn = ttl();
  const client = new sdk.S3Client(options);
  try {
    const url = await presigner.getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  } catch (_) { throw new Error('Media URL signing failed'); }
  finally { client.destroy(); }
}
async function remove(objectKey) {
  if (!validKey(objectKey)) throw new Error('Invalid object key');
  await command(sdk.DeleteObjectCommand, { Key: objectKey });
}
async function download(objectKey, destination) {
  if (!validKey(objectKey)) throw new Error('Invalid object key');
  const { bucket, options } = config();
  const client = new sdk.S3Client(options);
  try {
    const response = await client.send(new sdk.GetObjectCommand({ Bucket:bucket, Key:objectKey }));
    await require('stream/promises').pipeline(response.Body,fs.createWriteStream(destination,{ flags:'wx' }));
  } catch (_) { throw new Error('Object download failed'); }
  finally { client.destroy(); }
}
module.exports = { enabled, config, ttl, contentType, key, validKey, upload, verify, signedGet, remove, download };
