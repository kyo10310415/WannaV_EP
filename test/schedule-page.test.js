const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const LessonSchedule = require('../src/models/LessonSchedule');

const root = path.join(__dirname, '..');

test('スケジュールテンプレート一覧ルートを生徒IDルートより先に解決する', () => {
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'students.js'), 'utf8');
  const templatesRoute = routes.indexOf("router.get('/schedule-templates'");
  const studentRoute = routes.indexOf("router.get('/:userId'");

  assert.ok(templatesRoute >= 0);
  assert.ok(studentRoute >= 0);
  assert.ok(templatesRoute < studentRoute);
});

test('管理者のスケジュール概況はTutor未指定なら全生徒を取得する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = null;
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    await LessonSchedule.getOverviewForTutor();
    assert.match(capturedSql, /WHERE u\.role = '生徒'/);
    assert.doesNotMatch(capturedSql, /sp\.assigned_tutor_id = \$1/);
    assert.deepEqual(capturedParams, []);
  } finally {
    db.query = originalQuery;
  }
});

test('クルーまたはTutor指定時は担当生徒だけの概況を取得する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = null;
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    await LessonSchedule.getOverviewForTutor(42);
    assert.match(capturedSql, /sp\.assigned_tutor_id = \$1/);
    assert.deepEqual(capturedParams, [42]);
  } finally {
    db.query = originalQuery;
  }
});

test('受講スケジュールの生徒選択肢は生徒情報APIの項目名を使う', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-schedule.html'), 'utf8');

  assert.match(html, /s\.student_name \|\| s\.name \|\| s\.student_username \|\| s\.username/);
  assert.match(html, /filter\(s => s\.user_id \|\| s\.id\)/);
});
