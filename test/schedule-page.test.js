const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const LessonSchedule = require('../src/models/LessonSchedule');
const StudentProfile = require('../src/models/StudentProfile');

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
    assert.match(capturedSql, /COALESCE\(ns\.contract_plan, sp\.contract_plan\) = 'エントリープラン'/);
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
  assert.match(html, /contractPlan=.*エントリープラン/);
});

test('生徒一覧を契約プランでDB絞り込みできる', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = null;
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  try {
    await StudentProfile.getAll({ contractPlan: 'エントリープラン' });
    assert.match(capturedSql, /COALESCE\(ns\.contract_plan, sp\.contract_plan\) = \$1/);
    assert.deepEqual(capturedParams, ['エントリープラン']);
  } finally {
    db.query = originalQuery;
  }
});

test('テンプレート入力を検証し対象プランをエントリープランに固定する', () => {
  assert.throws(
    () => LessonSchedule.normalizeTemplateData({ name: '空', items: [] }),
    /1件以上のレッスン/
  );
  assert.throws(
    () => LessonSchedule.normalizeTemplateData({
      name: '日付なし',
      items: [{ lessonId: 10, dayOffset: null, dueOffset: 1, priority: 1 }]
    }),
    /dayOffsetは0以上の整数/
  );

  const normalized = LessonSchedule.normalizeTemplateData({
    name: ' テスト ',
    description: '',
    contractPlan: 'スタンダードプラン',
    items: [{ lessonId: 10, dayOffset: 0, dueOffset: 0, priority: 0, note: '' }]
  });
  assert.equal(normalized.name, 'テスト');
  assert.equal(normalized.description, null);
  assert.equal(normalized.contractPlan, 'エントリープラン');
  assert.equal(normalized.items[0].dayOffset, 0);
  assert.equal(normalized.items[0].dueOffset, 0);
  assert.equal(normalized.items[0].priority, 0);
});

test('テンプレート更新で説明を空欄へ戻せる', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  let capturedParams = null;
  db.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ id: 5 }] };
  };

  try {
    await LessonSchedule.updateTemplate(5, {
      name: 'テスト',
      description: null,
      items: [{ lessonId: 10, dayOffset: 0, dueOffset: null, priority: 1 }]
    });
    assert.match(capturedSql, /description = \$2/);
    assert.doesNotMatch(capturedSql, /description = COALESCE/);
    assert.equal(capturedParams[1], null);
    assert.equal(capturedParams[2], 'エントリープラン');
  } finally {
    db.query = originalQuery;
  }
});

test('テンプレート生成は0日オフセットを保持して一括コミットする', async () => {
  const originalConnect = db.pool.connect;
  const calls = [];
  const inserts = [];
  const client = {
    async query(sql, params) {
      calls.push(sql.trim());
      if (sql.includes('is_entry_plan_student')) {
        return { rows: [{ is_entry_plan_student: true }] };
      }
      if (sql.includes('SELECT * FROM schedule_templates')) {
        return { rows: [{
          id: 3,
          name: 'テスト',
          description: null,
          items: [
            { lessonId: 10, dayOffset: 0, dueOffset: 0, priority: 0, note: null },
            { lessonId: 11, dayOffset: 0, dueOffset: 7, priority: 1, note: '確認' }
          ]
        }] };
      }
      if (sql.includes('INSERT INTO lesson_schedules')) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.pool.connect = async () => client;

  try {
    const created = await LessonSchedule.bulkCreateFromTemplate(20, 3, '2026-09-01', 7);
    assert.equal(created.length, 2);
    assert.equal(inserts[0][2], '2026-09-01');
    assert.equal(inserts[0][3], '2026-09-01');
    assert.equal(inserts[0][5], 0);
    assert.equal(inserts[1][2], '2026-09-01');
    assert.equal(inserts[1][3], '2026-09-08');
    assert.ok(calls.includes('COMMIT'));
    assert.equal(calls.includes('ROLLBACK'), false);
    assert.ok(calls.some(sql => /is_active = true/.test(sql)));
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('テンプレート生成中の1件失敗で全件ロールバックする', async () => {
  const originalConnect = db.pool.connect;
  const calls = [];
  let insertCount = 0;
  const client = {
    async query(sql) {
      calls.push(sql.trim());
      if (sql.includes('is_entry_plan_student')) {
        return { rows: [{ is_entry_plan_student: true }] };
      }
      if (sql.includes('SELECT * FROM schedule_templates')) {
        return { rows: [{
          name: 'テスト',
          items: [
            { lessonId: 10, dayOffset: 0, dueOffset: 1, priority: 1 },
            { lessonId: 11, dayOffset: 1, dueOffset: 1, priority: 1 }
          ]
        }] };
      }
      if (sql.includes('INSERT INTO lesson_schedules')) {
        insertCount++;
        if (insertCount === 2) throw new Error('insert failed');
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.pool.connect = async () => client;

  try {
    await assert.rejects(
      () => LessonSchedule.bulkCreateFromTemplate(20, 3, '2026-09-01', 7),
      /insert failed/
    );
    assert.ok(calls.includes('ROLLBACK'));
    assert.equal(calls.includes('COMMIT'), false);
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('生成件数表示とエントリープランのAPI制限が画面・ルートに定義されている', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-schedule.html'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'students.js'), 'utf8');

  assert.match(html, /Number\(result\.created\)\|\|0/);
  assert.doesNotMatch(html, /result\.created\?\.length/);
  assert.match(html, /1件以上のレッスンを追加してください/);
  assert.match(routes, /requireEntryPlanStudent/);
  assert.match(routes, /requireEntryPlanSchedule/);
});
