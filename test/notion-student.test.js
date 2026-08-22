const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { parsePage } = require('../src/utils/notionSync');
const { mergeStudentRecords } = require('../src/utils/studentDirectory');
const NotionStudent = require('../src/models/NotionStudent');
const User = require('../src/models/User');
const db = require('../src/config/database');
const { auth } = require('../src/middleware/auth');

test('Notionの学籍番号をログインIDとして取得する', () => {
  const page = {
    id: 'notion-page-1',
    url: 'https://www.notion.so/notion-page-1',
    properties: {
      名前: { type: 'title', title: [{ plain_text: '山田 太郎' }] },
      学籍番号: { type: 'rich_text', rich_text: [{ plain_text: 'ST-001' }] },
      契約プラン: { type: 'select', select: { name: 'エントリープラン' } },
    },
  };

  const student = parsePage(page);
  assert.equal(student.studentName, '山田 太郎');
  assert.equal(student.loginId, 'ST-001');
  assert.equal(student.contractPlan, 'エントリープラン');
});

test('アカウント未作成のNotion生徒も生徒管理一覧へ含める', () => {
  const merged = mergeStudentRecords([], [{
    notion_page_id: 'notion-page-1',
    student_name: '山田 太郎',
    login_id: 'ST-001',
    contract_plan: 'エントリープラン',
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].record_source, 'notion');
  assert.equal(merged[0].has_account, false);
  assert.equal(merged[0].student_login_id, 'ST-001');
});

test('学籍番号が一致するNotion生徒と既存アカウントを重複表示しない', () => {
  const merged = mergeStudentRecords([{
    user_id: 10,
    student_name: '山田 太郎',
    student_username: 'ST-001',
    student_email: 'ST-001@wannav.local',
  }], [{
    notion_page_id: 'notion-page-1',
    student_name: '山田 太郎',
    login_id: 'ST-001',
    contract_plan: 'エントリープラン',
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].record_source, 'account+notion');
  assert.equal(merged[0].has_account, true);
  assert.equal(merged[0].student_login_id, 'ST-001');
});

test('Notion同期で初期PW 1111の生徒アカウントを作成する', async () => {
  const originalConnect = db.pool.connect;
  const originalCreate = User.create;
  const calls = [];
  let createArgs = null;

  const client = {
    async query(sql, params) {
      calls.push(sql.trim().split('\n')[0]);
      if (sql.includes('COUNT(*)::integer') && sql.includes('LOWER(login_id)')) {
        return { rows: [{ count: 1 }] };
      }
      if (sql.includes('JOIN student_profiles')) return { rows: [] };
      if (sql.includes('LOWER(username)')) return { rows: [] };
      if (sql.includes('SELECT notion_page_id FROM student_profiles')) return { rows: [] };
      if (sql.includes('SELECT user_id FROM student_profiles')) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };

  db.pool.connect = async () => client;
  User.create = async (...args) => {
    createArgs = args;
    return { id: 123, username: args[0], role: args[3] };
  };

  try {
    const result = await NotionStudent.provisionAccount({
      notionPageId: 'notion-page-1',
      loginId: 'ST-001',
      studentName: null,
    });
    assert.equal(result.status, 'created');
    assert.equal(createArgs[0], 'ST-001');
    assert.equal(createArgs[1], '1111');
    assert.equal(createArgs[3], '生徒');
    assert.ok(calls.includes('COMMIT'));
  } finally {
    db.pool.connect = originalConnect;
    User.create = originalCreate;
  }
});

test('自動作成アカウントは初回パスワード変更が未完了の状態で保存される', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const queryable = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ id: 1, username: params[3], role: params[4] }] };
    },
  };

  await User.create('ST-001', '1111', '山田 太郎', '生徒', queryable);
  assert.equal(capturedParams[0], 'ST-001@wannav.local');
  assert.equal(capturedParams[3], 'ST-001');
  assert.equal(await bcrypt.compare('1111', capturedParams[1]), true);
  assert.equal(capturedSql.includes('password_changed_at'), false);
});

test('初回パスワード未変更トークンでは保護APIを利用できない', async () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  const token = jwt.sign({ id: 1, role: '生徒', passwordChangeRequired: true }, process.env.JWT_SECRET);
  const req = { header: () => `Bearer ${token}` };
  const response = {};
  const res = {
    status(code) { response.status = code; return this; },
    json(body) { response.body = body; return this; },
  };
  let nextCalled = false;

  try {
    await auth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PASSWORD_CHANGE_REQUIRED');
  } finally {
    if (originalSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
});
