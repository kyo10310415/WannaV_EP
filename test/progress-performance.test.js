const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const Progress = require('../src/models/Progress');
const StudentProfile = require('../src/models/StudentProfile');
const NotionStudent = require('../src/models/NotionStudent');

const root = path.join(__dirname, '..');

test('進捗一覧はNotion契約ステータスと学習状況を分離してページングする', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    await Progress.getAllUsersProgress({ limit: 50, offset: 100 });
    assert.match(capturedSql, /COALESCE\(ns\.status, sp\.status, '未設定'\) AS contract_status/);
    assert.match(capturedSql, /WHEN p\.last_activity IS NULL THEN '未受講'/);
    assert.match(capturedSql, /LIMIT \$1 OFFSET \$2/);
    assert.doesNotMatch(capturedSql, /CROSS JOIN lessons l/);
    assert.deepEqual(capturedParams, [50, 100]);
  } finally {
    db.query = originalQuery;
  }
});

test('ユーザー進捗画面は未受講者を非アクティブ扱いしない', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-users.html'), 'utf8');
  assert.match(html, /契約ステータス/);
  assert.match(html, /学習状況/);
  assert.match(html, /🆕 未受講/);
  assert.doesNotMatch(html, /:\s*999/);
  assert.match(html, /PAGE_SIZE = 50/);
});

test('生徒管理一覧はDB側フィルターとページングを使用する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    const result = await StudentProfile.getDirectoryPage({
      status: 'アクティブ',
      contractPlan: 'エントリープラン',
      search: '山田',
      limit: 50,
      offset: 50,
    });
    assert.match(capturedSql, /WITH accounts AS/);
    assert.match(capturedSql, /d\.status = \$2/);
    assert.match(capturedSql, /d\.contract_plan = \$3/);
    assert.match(capturedSql, /ILIKE \$4/);
    assert.match(capturedSql, /LIMIT \$5 OFFSET \$6/);
    assert.equal(capturedParams[4], 50);
    assert.equal(capturedParams[5], 50);
    assert.deepEqual(result.students, []);
  } finally {
    db.query = originalQuery;
  }
});

test('生徒管理画面は全件DOM描画ではなく50件単位でAPI取得する', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-student-management.html'), 'utf8');
  assert.match(html, /const PAGE_SIZE = 50/);
  assert.match(html, /new URLSearchParams\(\{ limit: PAGE_SIZE, offset \}\)/);
  assert.match(html, /renderPagination\(data\.pagination/);
  assert.doesNotMatch(html, /allStudents\.filter\(s =>/);
});

test('Notion同期は一括UPSERTし変更のない既存アカウントを再確認しない', async () => {
  const originalQuery = db.query;
  const originalProvision = NotionStudent.provisionAccount;
  const queries = [];
  let provisionCalls = 0;
  db.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('AS has_account')) {
      return {
        rows: [{
          notion_page_id: 'page-1',
          login_id: 'ST-001',
          login_id_overridden: false,
          has_account: true,
        }],
      };
    }
    return { rows: [] };
  };
  NotionStudent.provisionAccount = async () => {
    provisionCalls++;
    return { status: 'linked' };
  };

  try {
    const result = await NotionStudent.upsertMany([{
      notionPageId: 'page-1',
      studentName: '山田 太郎',
      studentNumber: 'ST-001',
      loginId: 'ST-001',
      contractPlan: 'エントリープラン',
    }]);
    assert.ok(queries.some(sql => sql.includes('jsonb_to_recordset')));
    assert.equal(provisionCalls, 0);
    assert.equal(result.upserted, 1);
    assert.equal(result.accountsSkipped, 1);
  } finally {
    db.query = originalQuery;
    NotionStudent.provisionAccount = originalProvision;
  }
});

test('定期処理はNotionステータスと正しい最終視聴日時を参照する', () => {
  const scheduler = fs.readFileSync(path.join(root, 'src', 'utils', 'scheduler.js'), 'utf8');
  assert.match(scheduler, /COALESCE\(ns\.status, sp\.status\) = 'アクティブ'/);
  assert.match(scheduler, /MAX\(up\.last_watched_at\)/);
  assert.doesNotMatch(scheduler, /up\.last_accessed/);
  assert.doesNotMatch(scheduler, /'auto_expiry',\s*\/\/ trigger_type/);
});

test('一覧検索に必要な複合・式インデックスを作成する', () => {
  const schema = fs.readFileSync(path.join(root, 'src', 'models', 'schema.js'), 'utf8');
  assert.match(schema, /idx_users_username_lower/);
  assert.match(schema, /idx_progress_user_last_watched/);
  assert.match(schema, /idx_satisfaction_student_created/);
  assert.match(schema, /idx_extension_reviews_student_status/);
});
