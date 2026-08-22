const axios = require('axios');
const fs = require('fs');
const { JWT } = require('google-auth-library');

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_CHARACTER_FOLDER_ID
  || '18e54lUo2W302XTiGMI_qe0XNzTXILOWO';
const CACHE_TTL_MS = Number(process.env.GOOGLE_DRIVE_CHARACTER_CACHE_MS) || 5 * 60 * 1000;

let authClientCache = null;
let catalogueCache = null;

function parseJsonCredential(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
    } catch (_) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON をJSONまたはBase64形式で読み取れません');
    }
  }
}

function getServiceAccountCredentials() {
  let credentials = null;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = parseJsonCredential(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  }

  const clientEmail = credentials?.client_email
    || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    || process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = credentials?.private_key
    || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    || process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Google Driveサービスアカウントが未設定です。GOOGLE_SERVICE_ACCOUNT_JSON、またはGOOGLE_SERVICE_ACCOUNT_EMAILとGOOGLE_PRIVATE_KEYを設定してください'
    );
  }

  return {
    clientEmail,
    privateKey: String(privateKey).replace(/\\n/g, '\n'),
  };
}

async function getAccessToken() {
  if (!authClientCache) {
    const { clientEmail, privateKey } = getServiceAccountCredentials();
    authClientCache = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: [DRIVE_READ_SCOPE],
    });
  }

  const tokenResult = await authClientCache.getAccessToken();
  const accessToken = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!accessToken) throw new Error('Google Driveのアクセストークンを取得できません');
  return accessToken;
}

async function driveGet(pathname, params = {}) {
  const accessToken = await getAccessToken();
  return axios.get(`${DRIVE_API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    timeout: 30000,
  });
}

async function listFolder(folderId) {
  const files = [];
  let pageToken;
  do {
    const response = await driveGet('/files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,createdTime,modifiedTime)',
      pageSize: 1000,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return files;
}

function normalizeImage(file, category) {
  return {
    fileId: file.id,
    fileName: file.name,
    category,
    mimeType: file.mimeType,
    thumbnailLink: file.thumbnailLink || null,
    webViewLink: file.webViewLink || null,
  };
}

async function loadCatalogue() {
  const rootItems = await listFolder(ROOT_FOLDER_ID);
  const femaleFolderId = process.env.GOOGLE_DRIVE_FEMALE_FOLDER_ID
    || rootItems.find(item => item.mimeType === FOLDER_MIME_TYPE && item.name === '女性')?.id;
  const maleFolderId = process.env.GOOGLE_DRIVE_MALE_FOLDER_ID
    || rootItems.find(item => item.mimeType === FOLDER_MIME_TYPE && item.name === '男性')?.id;

  if (!femaleFolderId || !maleFolderId) {
    throw new Error('Google Drive内に「女性」「男性」フォルダが見つかりません');
  }

  const [femaleFiles, maleFiles] = await Promise.all([
    listFolder(femaleFolderId),
    listFolder(maleFolderId),
  ]);
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  const images = [
    ...femaleFiles.filter(file => file.mimeType?.startsWith('image/')).map(file => normalizeImage(file, '女性')),
    ...maleFiles.filter(file => file.mimeType?.startsWith('image/')).map(file => normalizeImage(file, '男性')),
  ].sort((a, b) => a.category.localeCompare(b.category, 'ja')
    || collator.compare(a.fileName, b.fileName));

  return {
    images,
    byId: new Map(images.map(image => [image.fileId, image])),
    loadedAt: Date.now(),
  };
}

async function getCatalogue({ force = false } = {}) {
  if (!force && catalogueCache && Date.now() - catalogueCache.loadedAt < CACHE_TTL_MS) {
    return catalogueCache;
  }
  catalogueCache = await loadCatalogue();
  return catalogueCache;
}

function imagePath(fileId) {
  return `/api/characters/images/${encodeURIComponent(fileId)}`;
}

function toPublicImage(image) {
  return {
    fileId: image.fileId,
    fileName: image.fileName,
    category: image.category,
    imageUrl: imagePath(image.fileId),
  };
}

async function getAllowedImage(fileId) {
  const catalogue = await getCatalogue();
  return catalogue.byId.get(fileId) || null;
}

async function streamThumbnail(fileId) {
  const image = await getAllowedImage(fileId);
  if (!image?.thumbnailLink) return null;
  const accessToken = await getAccessToken();
  const response = await axios.get(image.thumbnailLink, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'stream',
    timeout: 30000,
  });
  return { image, response };
}

async function streamImage(fileId) {
  const image = await getAllowedImage(fileId);
  if (!image) return null;
  const accessToken = await getAccessToken();
  const response = await axios.get(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { alt: 'media', supportsAllDrives: true },
    responseType: 'stream',
    timeout: 30000,
  });
  return { image, response };
}

function clearCaches() {
  authClientCache = null;
  catalogueCache = null;
}

module.exports = {
  getCatalogue,
  getAllowedImage,
  streamThumbnail,
  streamImage,
  toPublicImage,
  imagePath,
  clearCaches,
  parseJsonCredential,
  getServiceAccountCredentials,
};
