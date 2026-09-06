const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const Progress = require('../src/models/Progress');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('順次解禁は小テストがある前レッスンの合格状態も確認する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [{ can_access: true }] };
  };
  try {
    assert.equal(await Progress.canAccessLesson(5, 9), true);
    assert.match(capturedSql, /NOT EXISTS[\s\S]*FROM quiz_questions qq[\s\S]*qq\.lesson_id = previous\.id/);
    assert.match(capturedSql, /OR up\.quiz_passed = true/);
  } finally {
    db.query = originalQuery;
  }
});

test('小テストなし動画は95%視聴後も自動完了せず完了ボタンを表示する', () => {
  const route = read('src/routes/lessons.js');
  const page = read('views/lesson.html');

  assert.match(route, /questions\.length === 0[\s\S]*ready_to_complete: true/);
  assert.doesNotMatch(route, /auto_completed: true/);
  assert.match(page, /data\.ready_to_complete/);
  assert.match(page, /「視聴完了」を押すと次のレッスンが解放/);
  assert.doesNotMatch(page, /data\.auto_completed/);
});

test('小テストありレッスンは手動完了APIで完了にできない', () => {
  const route = read('src/routes/lessons.js');
  const manualRouteStart = route.indexOf("router.post('/:id/manual-complete'");
  const quizRouteStart = route.indexOf("router.post('/:id/quiz'", manualRouteStart);
  const manualRoute = route.slice(manualRouteStart, quizRouteStart);

  assert.match(manualRoute, /Quiz\.getQuestionsByLesson\(lessonId\)/);
  assert.match(manualRoute, /questions\.length > 0/);
  assert.match(manualRoute, /status\(409\)/);
  assert.match(manualRoute, /quiz_required: true/);
  assert.ok(manualRoute.indexOf('questions.length > 0') < manualRoute.indexOf('Progress.completeByWatching'));
});

test('クイズ未合格の既存完了記録を起動時に補正する', () => {
  const schema = read('src/models/schema.js');
  assert.match(schema, /idx_quiz_questions_lesson ON quiz_questions\(lesson_id\)/);
  assert.match(schema, /UPDATE user_progress up[\s\S]*SET completed = false/);
  assert.match(schema, /COALESCE\(up\.quiz_passed, false\) = false/);
  assert.match(schema, /EXISTS[\s\S]*quiz_questions qq/);
});

test('小テストあり教材では手動完了ボタンを隠して小テスト導線だけを表示する', () => {
  const page = read('views/lesson.html');
  assert.match(page, /if \(questions\.length > 0\)[\s\S]*manual-complete-section'\)\.style\.display = 'none'/);
  assert.match(page, /btn\.textContent = '📝 小テストに進む'/);
});
