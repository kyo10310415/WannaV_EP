const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const Quiz = require('../src/models/Quiz');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('クイズ一括保存は削除・追加・未合格進捗補正を同じトランザクションで行う', async () => {
  const originalConnect = db.pool.connect;
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO quiz_questions/.test(sql)) {
        return { rows: [{ id: 1, lesson_id: params[0], question: params[1] }] };
      }
      return { rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE' }),
  };
  db.pool.connect = async () => client;

  try {
    const created = await Quiz.replaceByLesson(12, [{
      question: '問題', options: ['A', 'B', 'C'], correctAnswer: 1, orderIndex: 0,
    }]);
    assert.equal(created.length, 1);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.match(calls[1].sql, /DELETE FROM quiz_questions/);
    assert.match(calls[2].sql, /INSERT INTO quiz_questions/);
    assert.match(calls[3].sql, /UPDATE user_progress/);
    assert.equal(calls[4].sql, 'COMMIT');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('クイズ保存APIは入力を検証して一括保存モデルを使用する', () => {
  const route = read('src/routes/admin.js');
  const start = route.indexOf("router.post('/lessons/:lessonId/quiz'");
  const end = route.indexOf('// クイズ取得', start);
  const quizRoute = route.slice(start, end);

  assert.match(quizRoute, /Array\.isArray\(questions\)/);
  assert.match(quizRoute, /item\.options\.length !== 3/);
  assert.match(quizRoute, /Number\.isInteger\(item\.correctAnswer\)/);
  assert.match(quizRoute, /Quiz\.replaceByLesson\(lessonId, normalized\)/);
});

test('管理画面は保存中・成功・失敗をクイズ欄の近くに表示する', () => {
  const page = read('views/admin-contents.html');
  assert.match(page, /id="quiz-editor"[\s\S]*onsubmit="saveQuiz\(event\)"/);
  assert.match(page, /id="quiz-save-btn"/);
  assert.match(page, /id="quiz-save-status"[\s\S]*aria-live="polite"/);
  assert.match(page, /クイズを保存しています/);
  assert.match(page, /クイズを保存しました/);
  assert.match(page, /saveButton\.disabled = true/);
});

test('DBの正解番号を管理画面用の項目名へ変換する', async () => {
  const originalQuery = db.query;
  db.query = async () => ({
    rows: [{
      id: 1,
      lesson_id: 2,
      question: '問題',
      options: ['A', 'B', 'C'],
      correct_answer: 2,
      order_index: 4,
    }],
  });
  try {
    const [question] = await Quiz.getQuestionsByLesson(2);
    assert.equal(question.correctAnswer, 2);
    assert.equal(question.orderIndex, 4);
  } finally {
    db.query = originalQuery;
  }
});
