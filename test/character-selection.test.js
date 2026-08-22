const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const CharacterSelection = require('../src/models/CharacterSelection');
const {
  parseJsonCredential,
  getServiceAccountCredentials,
  toPublicImage,
} = require('../src/utils/googleDriveCharacters');
const { checkRole } = require('../src/middleware/auth');

const root = path.join(__dirname, '..');

test('GoogleサービスアカウントJSONを通常形式とBase64形式で読み取る', () => {
  const credential = { client_email: 'drive@example.test', private_key: 'private-key' };
  assert.deepEqual(parseJsonCredential(JSON.stringify(credential)), credential);
  assert.deepEqual(
    parseJsonCredential(Buffer.from(JSON.stringify(credential)).toString('base64')),
    credential
  );
});

test('分割した環境変数からGoogleサービスアカウントを構成する', () => {
  const original = {
    json: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    path: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    serviceKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    key: process.env.GOOGLE_PRIVATE_KEY,
  };
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CLIENT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'drive@example.test';
  process.env.GOOGLE_PRIVATE_KEY = 'line1\\nline2';

  try {
    assert.deepEqual(getServiceAccountCredentials(), {
      clientEmail: 'drive@example.test',
      privateKey: 'line1\nline2',
    });
  } finally {
    if (original.json == null) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = original.json;
    if (original.path == null) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = original.path;
    if (original.email == null) delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    else process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = original.email;
    if (original.clientEmail == null) delete process.env.GOOGLE_CLIENT_EMAIL;
    else process.env.GOOGLE_CLIENT_EMAIL = original.clientEmail;
    if (original.serviceKey == null) delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    else process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = original.serviceKey;
    if (original.key == null) delete process.env.GOOGLE_PRIVATE_KEY;
    else process.env.GOOGLE_PRIVATE_KEY = original.key;
  }
});

test('公開用画像情報はアプリ内の許可画像URLを使用する', () => {
  assert.deepEqual(toPublicImage({
    fileId: 'drive-file_1',
    fileName: '女性1.png',
    category: '女性',
  }), {
    fileId: 'drive-file_1',
    fileName: '女性1.png',
    category: '女性',
    imageUrl: '/api/characters/images/drive-file_1',
  });
});

test('生徒のキャラクター選択をpending状態で予約する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ id: 1, student_user_id: params[0], drive_file_id: params[1], status: 'pending' }] };
  };

  try {
    const selection = await CharacterSelection.createPending({
      studentUserId: 10,
      fileId: 'drive-file-1',
      fileName: '男性1.png',
      category: '男性',
    });
    assert.match(capturedSql, /INSERT INTO character_selections/);
    assert.match(capturedSql, /'pending'/);
    assert.deepEqual(capturedParams, [10, 'drive-file-1', '男性1.png', '男性']);
    assert.equal(selection.status, 'pending');
  } finally {
    db.query = originalQuery;
  }
});

test('キャラクター管理権限は管理者とセールスだけに許可する', () => {
  const middleware = checkRole('管理者', 'セールス');
  const response = {};
  const res = {
    status(code) { response.status = code; return this; },
    json(body) { response.body = body; return this; },
  };
  let nextCalled = false;
  middleware({ user: { role: '生徒' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.status, 403);

  middleware({ user: { role: 'セールス' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('DB制約・API・画面にキャラクター選択フローが定義されている', () => {
  const schema = fs.readFileSync(path.join(root, 'src', 'models', 'schema.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'characters.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'views', 'dashboard.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'views', 'admin-character-management.html'), 'utf8');
  const studentManagement = fs.readFileSync(path.join(root, 'views', 'admin-student-management.html'), 'utf8');

  assert.match(schema, /student_user_id INTEGER NOT NULL UNIQUE/);
  assert.match(schema, /drive_file_id VARCHAR\(255\) NOT NULL UNIQUE/);
  assert.match(routes, /checkRole\('生徒'\)/);
  assert.match(routes, /checkRole\('管理者', 'セールス'\)/);
  assert.match(routes, /streamThumbnail/);
  assert.doesNotMatch(routes, /res\.redirect\(/);
  assert.match(dashboard, /このキャラクターでいいですか？/);
  assert.match(dashboard, /switchCharacterCategory\('女性'\)/);
  assert.match(dashboard, /switchCharacterCategory\('男性'\)/);
  assert.match(admin, /キャラクター選択中/);
  assert.match(admin, /キャラクター確定済み/);
  assert.match(studentManagement, /value="アクティブ" selected/);
});
