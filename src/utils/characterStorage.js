const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { streamImage } = require('./googleDriveCharacters');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const GENERATED_FILE_PATTERN = /^character-\d+-[0-9a-f-]{36}\.(?:png|jpg|webp|gif|avif)$/;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

function storageError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getCharacterStorageDir() {
  if (process.env.NODE_ENV === 'production' && !process.env.UPLOAD_DIR) {
    throw storageError(
      '本番環境の永続ストレージが未設定です。Render Diskをマウントし、UPLOAD_DIRを設定してください',
      'CHARACTER_STORAGE_NOT_PERSISTENT'
    );
  }
  const uploadDir = global.UPLOAD_DIR
    || (process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '../../uploads'));
  return global.CHARACTERS_DIR || path.join(uploadDir, 'characters');
}

function extensionFor(mimeType, originalFileName = '') {
  const byMime = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (byMime[normalizedMime]) return byMime[normalizedMime];
  const originalExtension = path.extname(originalFileName).slice(1).toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(originalExtension)
    ? originalExtension.replace('jpeg', 'jpg')
    : 'img';
}

function resolveStoredImagePath(fileName) {
  if (!GENERATED_FILE_PATTERN.test(String(fileName || '')) || path.basename(fileName) !== fileName) {
    return null;
  }
  const storageDir = path.resolve(getCharacterStorageDir());
  const resolved = path.resolve(storageDir, fileName);
  return path.dirname(resolved) === storageDir ? resolved : null;
}

function storedImageUrl(selectionId) {
  return `/api/characters/stored/${encodeURIComponent(selectionId)}`;
}

function createSizeLimiter(maxBytes) {
  let receivedBytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(storageError('キャラクター画像のサイズが上限を超えています', 'CHARACTER_IMAGE_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function saveDriveImage({ selectionId, driveFileId, originalFileName }) {
  const numericSelectionId = Number(selectionId);
  if (!Number.isInteger(numericSelectionId) || numericSelectionId <= 0) {
    throw storageError('キャラクター選択IDが不正です', 'CHARACTER_SELECTION_INVALID');
  }

  const streamed = await streamImage(driveFileId);
  if (!streamed) {
    throw storageError('Google Driveに選択画像が見つかりません', 'CHARACTER_DRIVE_IMAGE_NOT_FOUND');
  }

  const mimeType = String(
    streamed.response.headers['content-type'] || streamed.image.mimeType || 'application/octet-stream'
  ).split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    streamed.response.data.destroy();
    throw storageError('保存できない画像形式です', 'CHARACTER_IMAGE_TYPE_UNSUPPORTED');
  }

  const configuredMaxBytes = Number(process.env.CHARACTER_IMAGE_MAX_BYTES);
  const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : DEFAULT_MAX_BYTES;
  const contentLength = Number(streamed.response.headers['content-length'] || 0);
  if (contentLength > maxBytes) {
    streamed.response.data.destroy();
    throw storageError('キャラクター画像のサイズが上限を超えています', 'CHARACTER_IMAGE_TOO_LARGE');
  }

  const storageDir = getCharacterStorageDir();
  await fs.promises.mkdir(storageDir, { recursive: true });
  const extension = extensionFor(mimeType, originalFileName || streamed.image.fileName);
  const fileName = `character-${numericSelectionId}-${randomUUID()}.${extension}`;
  const finalPath = resolveStoredImagePath(fileName);
  const temporaryPath = `${finalPath}.tmp`;
  let finalFileCreated = false;

  try {
    await pipeline(
      streamed.response.data,
      createSizeLimiter(maxBytes),
      fs.createWriteStream(temporaryPath, { flags: 'wx' })
    );
    await fs.promises.rename(temporaryPath, finalPath);
    finalFileCreated = true;
    const stats = await fs.promises.stat(finalPath);
    return { fileName, mimeType, size: stats.size };
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(unlinkError => {
      if (unlinkError.code !== 'ENOENT') console.error('Character temp file cleanup error:', unlinkError);
    });
    if (finalFileCreated) {
      await fs.promises.unlink(finalPath).catch(unlinkError => {
        if (unlinkError.code !== 'ENOENT') console.error('Character final file cleanup error:', unlinkError);
      });
    }
    throw error;
  }
}

async function deleteStoredImage(fileName) {
  if (!fileName) return false;
  const storedPath = resolveStoredImagePath(fileName);
  if (!storedPath) throw storageError('保存画像のパスが不正です', 'CHARACTER_STORAGE_PATH_INVALID');
  try {
    await fs.promises.unlink(storedPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  getCharacterStorageDir,
  resolveStoredImagePath,
  storedImageUrl,
  saveDriveImage,
  deleteStoredImage,
  extensionFor,
};
