const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('./objectStorage');
const { execFile } = require('child_process');

function stagingDir() {
  const dir = path.join(os.tmpdir(), 'wannav-media-staging');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function stage(file, kind, staged) {
  if (!storage.enabled()) return null;
  const objectKey = storage.key(kind, file.filename);
  staged.push(objectKey); // Even a successful PUT followed by a failed HEAD must be cleaned up.
  await storage.upload(file.path, objectKey);
  return objectKey;
}
async function discard(keys) {
  for (const key of keys) {
    try {
      const referenced = await require('../config/database').query('SELECT id FROM lessons WHERE video_storage_key = $1 OR image_storage_key = $1 LIMIT 1',[key]);
      if (!referenced.rows.length) await storage.remove(key);
    }
    catch (_) { console.error('Object cleanup failed; retained orphan key:', key); }
  }
}
async function removeReplaced(oldLesson, current) {
  const keys = ['video_storage_key','image_storage_key'].filter(field => oldLesson?.[field] && oldLesson[field] !== current?.[field])
    .map(field => oldLesson[field]);
  await discard(keys);
}
async function optimizeImage(file) {
  if (!storage.enabled() || path.extname(file.filename).toLowerCase() !== '.png') return file;
  // Do not flatten animated PNGs into a single frame.
  if ((await fs.promises.readFile(file.path)).includes(Buffer.from('acTL'))) return file;
  const output = file.path + '.webp';
  try {
    await new Promise((resolve, reject) => execFile('ffmpeg', ['-i',file.path,'-frames:v','1','-c:v','libwebp','-lossless','1','-y',output],
      { timeout:30000 }, error => error ? reject(error) : resolve()));
    if ((await fs.promises.stat(output)).size < file.size) return { ...file, path:output, filename:file.filename.replace(/\.png$/i,'.webp') };
  } catch (_) { /* Preserve original quality and availability when compression is unavailable. */ }
  await fs.promises.unlink(output).catch(() => {});
  return file;
}
async function mediaUrl(lesson, kind) {
  const objectKey = lesson[`${kind}_storage_key`];
  if (objectKey && storage.enabled()) return { ...await storage.signedGet(objectKey), storage:'object', contentType:storage.contentType(objectKey) };
  const url = lesson[`${kind}_url`];
  if (objectKey) {
    const root = global.UPLOAD_DIR || path.join(__dirname,'../../uploads');
    const filename = lesson[`${kind}_filename`];
    if (!filename || path.basename(filename) !== filename || !url?.startsWith('/uploads/') || !fs.existsSync(path.join(root,filename))) {
      throw new Error('Object storage required for this media');
    }
  }
  if (!url) return null;
  return { url, storage:url.startsWith('/uploads/') ? 'local' : 'external', expiresAt:null, contentType:storage.contentType(url) };
}
async function regenerateThumbnail(lesson) {
  let temporary;
  let videoPath = path.join(global.UPLOAD_DIR || path.join(__dirname,'../../uploads'),path.basename(lesson.video_filename));
  try {
    if (!fs.existsSync(videoPath) && lesson.video_storage_key) {
      temporary = path.join(stagingDir(),require('crypto').randomUUID() + path.extname(lesson.video_filename));
      await storage.download(lesson.video_storage_key,temporary);
      videoPath = temporary;
    }
    if (!fs.existsSync(videoPath)) return null;
    return await require('../utils/thumbnail').generateThumbnail(videoPath,lesson.video_filename);
  } finally { if (temporary) await fs.promises.unlink(temporary).catch(() => {}); }
}
module.exports = { stagingDir, stage, discard, removeReplaced, optimizeImage, mediaUrl, regenerateThumbnail };
