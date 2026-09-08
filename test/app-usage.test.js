const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const AppUsage = require('../src/models/AppUsage');
const Progress = require('../src/models/Progress');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('生徒のアプリ表示回数を日本時間の日単位で加算する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ usage_date: '2026-09-08', open_count: 2 }] };
  };

  try {
    const result = await AppUsage.recordOpen(42);
    assert.match(capturedSql, /INSERT INTO app_usage_daily/);
    assert.match(capturedSql, /AT TIME ZONE 'Asia\/Tokyo'/);
    assert.match(capturedSql, /WHERE id = \$1 AND role = '生徒'/);
    assert.match(capturedSql, /ON CONFLICT \(user_id, usage_date\)/);
    assert.match(capturedSql, /open_count = app_usage_daily\.open_count \+ 1/);
    assert.deepEqual(capturedParams, [42]);
    assert.equal(result.open_count, 2);
  } finally {
    db.query = originalQuery;
  }
});

test('利用回数テーブルと集計用インデックスを作成する', () => {
  const schema = read('src/models/schema.js');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_usage_daily/);
  assert.match(schema, /PRIMARY KEY \(user_id, usage_date\)/);
  assert.match(schema, /idx_app_usage_daily_date_user/);
});

test('生徒のダッシュボード表示時だけ利用回数APIを呼び出す', () => {
  const route = read('src/routes/usage.js');
  const server = read('server.js');
  const dashboard = read('views/dashboard.html');

  assert.match(route, /router\.post\('\/open', auth, checkRole\('生徒'\)/);
  assert.match(server, /app\.use\('\/api\/usage', require\('\.\/src\/routes\/usage'\)\)/);
  assert.match(dashboard, /currentUser\.role === '生徒'[\s\S]*recordAppOpen\(\)/);
  assert.match(dashboard, /fetch\(`\$\{API_URL\}\/usage\/open`/);
});

test('管理画面向けに本日・当月の合計と生徒別利用回数を集計する', async () => {
  const originalQuery = db.query;
  const queries = [];
  db.query = async sql => {
    queries.push(sql);
    return { rows: [] };
  };

  try {
    await Progress.getAllUsersProgress();
    await Progress.getAllUsersProgressSummary();
    assert.match(queries[0], /usage_by_user/);
    assert.match(queries[0], /daily_usage_count/);
    assert.match(queries[0], /monthly_usage_count/);
    assert.match(queries[0], /AT TIME ZONE 'Asia\/Tokyo'/);
    assert.match(queries[1], /usage_totals/);
    assert.match(queries[1], /usage_user\.role = '生徒'/);
  } finally {
    db.query = originalQuery;
  }
});

test('ユーザー進捗管理画面に全体と生徒別の利用回数を表示する', () => {
  const page = read('views/admin-users.html');
  assert.match(page, /本日の利用回数/);
  assert.match(page, /今月の利用回数/);
  assert.match(page, /<th>本日の利用<\/th>/);
  assert.match(page, /<th>今月の利用<\/th>/);
  assert.match(page, /user\.daily_usage_count/);
  assert.match(page, /user\.monthly_usage_count/);
});
