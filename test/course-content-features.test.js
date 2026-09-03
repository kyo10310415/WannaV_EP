const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const Progress = require('../src/models/Progress');

const root = path.join(__dirname, '..');

test('視聴記録は生徒・動画単位の回数を加算する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ user_id: params[0], lesson_id: params[1], view_count: 3 }] };
  };

  try {
    const result = await Progress.recordView(10, 20);
    assert.match(capturedSql, /INSERT INTO user_progress \(user_id, lesson_id, view_count, last_watched_at\)/);
    assert.match(capturedSql, /view_count = user_progress\.view_count \+ 1/);
    assert.deepEqual(capturedParams, [10, 20]);
    assert.equal(result.view_count, 3);
  } finally {
    db.query = originalQuery;
  }
});

test('コース別進捗はコースごとの完了数と割合を集計する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = [];
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    await Progress.getCourseProgressStats(7);
    assert.match(capturedSql, /GROUP BY c\.id, c\.title, c\.order_index/);
    assert.match(capturedSql, /FILTER \(WHERE COALESCE\(up\.completed, false\)\)/);
    assert.match(capturedSql, /up\.user_id = \$1/);
    assert.deepEqual(capturedParams, [7]);
  } finally {
    db.query = originalQuery;
  }
});

test('自由科目の視聴回数は動画合計と生徒別内訳を返す', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };

  try {
    await Progress.getFreeSubjectViewAnalytics();
    assert.match(capturedSql, /WHERE c\.title = '自由科目'/);
    assert.match(capturedSql, /SUM\(COALESCE\(up\.view_count, 0\)\).*u\.role = '生徒'/s);
    assert.match(capturedSql, /'studentNumber', u\.username/);
    assert.match(capturedSql, /'viewCount', COALESCE\(up\.view_count, 0\)/);
  } finally {
    db.query = originalQuery;
  }
});

test('ダッシュボードはコース単位で動画と進捗バーを描画する', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'dashboard.html'), 'utf8');
  assert.match(html, /コース別レッスン/);
  assert.match(html, /groupedCourses\.forEach/);
  assert.match(html, /course-section/);
  assert.match(html, /course-progress-bar/);
  assert.match(html, /group\.lessons\.forEach/);
  assert.match(html, /進捗.*courseStats/s);
  assert.doesNotMatch(html, /id="progress-fill"/);
});

test('管理画面は自由科目の合計・生徒別視聴回数を表示する', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-contents.html'), 'utf8');
  assert.match(html, /自由科目の視聴回数/);
  assert.match(html, /lessons\/free-subject\/view-analytics/);
  assert.match(html, /合計 \$\{Number\(lesson\.total_views\)/);
  assert.match(html, /学籍番号/);
  assert.match(html, /student\.viewCount/);
});

test('動画アップロード上限は既定2GBで設定可能かつ画面で事前検証する', () => {
  const adminRoutes = fs.readFileSync(path.join(root, 'src', 'routes', 'admin.js'), 'utf8');
  const adminPage = fs.readFileSync(path.join(root, 'views', 'admin-contents.html'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(adminRoutes, /MAX_VIDEO_UPLOAD_MB \|\| '2048'/);
  assert.match(adminRoutes, /limits: \{ fileSize: MAX_VIDEO_UPLOAD_BYTES \}/);
  assert.match(adminRoutes, /LIMIT_FILE_SIZE/);
  assert.match(adminPage, /validateVideoFileSize/);
  assert.match(adminPage, /new XMLHttpRequest\(\)/);
  assert.match(adminPage, /xhr\.upload\.addEventListener\('progress'/);
  assert.match(envExample, /MAX_VIDEO_UPLOAD_MB=2048/);
});

test('視聴回数カラムを既存DBにも追加し管理者閲覧を除外する', () => {
  const schema = fs.readFileSync(path.join(root, 'src', 'models', 'schema.js'), 'utf8');
  const lessonsRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'lessons.js'), 'utf8');
  assert.match(schema, /view_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS view_count/);
  assert.match(lessonsRoute, /req\.user\.role !== '生徒'/);
  assert.match(lessonsRoute, /recorded: false/);
});

test('管理者がコースを並べ替えてダッシュボードのセクション順を保存できる', () => {
  const adminRoutes = fs.readFileSync(path.join(root, 'src', 'routes', 'admin.js'), 'utf8');
  const adminPage = fs.readFileSync(path.join(root, 'views', 'admin-contents.html'), 'utf8');
  const lessonModel = fs.readFileSync(path.join(root, 'src', 'models', 'Lesson.js'), 'utf8');

  assert.match(adminPage, /ダッシュボードのセクション順/);
  assert.match(adminPage, /function moveCourse\(index, direction\)/);
  assert.match(adminPage, /function saveCourseOrder\(\)/);
  assert.match(adminPage, /body: JSON\.stringify\(\{ courseIds:/);
  assert.match(adminRoutes, /router\.patch\('\/courses\/order'/);
  assert.match(adminRoutes, /new Set\(courseIds\)\.size === courseIds\.length/);
  assert.match(adminRoutes, /UNNEST\(\$1::integer\[\]\) WITH ORDINALITY/);
  assert.match(adminRoutes, /client\.query\('COMMIT'\)/);
  assert.match(lessonModel, /ORDER BY c\.order_index, c\.id, l\.order_index, l\.id/);
});
