// Optional isolated PostgreSQL (PGlite) verification. Never connects to production.
// PGLITE_TEST_MODULE points to an externally installed @electric-sql/pglite.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const AppUsage = require('../src/models/AppUsage');
const Progress = require('../src/models/Progress');
const StudentPayment = require('../src/models/StudentPayment');
const { LearningAnalytics } = require('../src/models/LearningAnalytics');
const { createTables } = require('../src/models/schema');
const sheet = require('../src/utils/paymentSheet');

test('isolated PostgreSQL migration, visits, learning, payment and authorization', {
  skip: !process.env.PGLITE_TEST_MODULE
}, async t => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const pg = new PGlite();
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const oldEnv = { ...process.env };
  let now = null;
  const query = (sql, params) => pg.query(now ? sql.replaceAll('statement_timestamp()', "TIMESTAMPTZ '" + now + "'") : sql, params);
  db.query = query;
  db.pool.connect = async () => ({ query, release() {} });
  process.env.PORTAL_SESSION_INACTIVITY_MINUTES = '60';
  process.env.GOOGLE_PAYMENT_SPREADSHEET_ID = 'test-only';
  process.env.PAYMENT_ACCESS_CONTROL_ENABLED = 'true';
  try {
    await t.test('冪等マイグレーションを2回適用', async () => {
      await createTables();
      await createTables();
    });
    await query(`INSERT INTO users(id,email,password,name,username,role,password_changed_at)
      VALUES (1,'student@test','x','生徒','LOGIN-OVERRIDE','生徒',NOW()),
      (2,'staff@test','x','管理','staff','管理者',NOW()),
      (3,'missing@test','x','未紐付け','ST-03','生徒',NOW())`);
    await query(`INSERT INTO student_profiles(user_id,status,contract_plan)
      VALUES (1,'アクティブ','エントリープラン'), (3,'レッスン準備中','生徒プラン')`);
    await t.test('廃止データを削除し、共通プロフィール・他機能のログを保持する', async () => {
      await pg.exec(`CREATE TABLE handover_info(id INTEGER); INSERT INTO handover_info VALUES(1);
        CREATE TABLE extension_reviews(id INTEGER); INSERT INTO extension_reviews VALUES(1);
        ALTER TABLE student_profiles ADD COLUMN handover_completed BOOLEAN;
        ALTER TABLE student_profiles ADD COLUMN handover_completed_at TIMESTAMP;
        UPDATE student_profiles SET lesson_start_date='2026-09-20' WHERE user_id=1;
        INSERT INTO activity_logs(action) VALUES('handover_upsert'),('extension_review_start'),('keep_test');`);
      await createTables();
      await createTables();
      assert.equal((await query("SELECT to_regclass('handover_info') AS table_name")).rows[0].table_name, null);
      assert.equal((await query("SELECT to_regclass('extension_reviews') AS table_name")).rows[0].table_name, null);
      assert.deepEqual((await query('SELECT action FROM activity_logs')).rows.map(r => r.action), ['keep_test']);
      assert.equal((await query('SELECT lesson_start_date::text FROM student_profiles WHERE user_id=1')).rows[0].lesson_start_date, '2026-09-20');
      assert.equal((await query("SELECT COUNT(*)::integer AS n FROM information_schema.columns WHERE table_name='student_profiles' AND column_name LIKE 'handover_completed%'")).rows[0].n, 0);
      const StudentProfile = require('../src/models/StudentProfile');
      await StudentProfile.getDirectoryPage();
      await StudentProfile.getAll();
      await StudentProfile.getExpiringStudents();
    });
    await t.test('進捗対象はアクティブ・準備中かつ永久会員以外、一覧と集計が一致', async () => {
      await query('BEGIN');
      try {
        for (const [status, plan, count] of [['アクティブ','永久会員',1], ['休会','生徒プラン',1],
          ['レッスン準備中','PROプラン',2], ['アクティブ',null,2]]) {
          await query('UPDATE student_profiles SET status=$1, contract_plan=$2 WHERE user_id=1', [status, plan]);
          assert.equal((await Progress.getAllUsersProgress()).length, count);
          assert.equal((await Progress.getAllUsersProgressSummary()).total_students, count);
        }
        await query("INSERT INTO notion_students(notion_page_id,student_name,status,contract_plan) VALUES('filter-test','優先','休会','エントリープラン')");
        await query("UPDATE student_profiles SET notion_page_id='filter-test',status='アクティブ' WHERE user_id=1");
        assert.equal((await Progress.getAllUsersProgressSummary()).total_students, 1);
        await query("UPDATE notion_students SET status='アクティブ',contract_plan='永久会員' WHERE notion_page_id='filter-test'");
        assert.equal((await Progress.getAllUsersProgress()).length, 1);
        await query(`INSERT INTO app_usage_daily(user_id,usage_date,open_count,last_opened_at)
          VALUES(1,(NOW() AT TIME ZONE 'Asia/Tokyo')::date,99,NOW())`);
        await query(`INSERT INTO portal_active_days(user_id,activity_date)
          VALUES(1,(NOW() AT TIME ZONE 'Asia/Tokyo')::date)`);
        const summary = await Progress.getAllUsersProgressSummary();
        assert.equal(summary.daily_usage_count, 0);
        assert.equal(summary.monthly_usage_count, 0);
        assert.equal(summary.daily_active_students, 0);
        assert.equal(summary.monthly_active_student_days, 0);
      } finally { await query('ROLLBACK'); }
    });
    await t.test('初回1回・同時イベント20回でも重複しない・スタッフ対象外', async () => {
      now = '2026-09-22T01:00:00Z';
      assert.equal((await AppUsage.recordOpen(1)).recorded, true);
      const duplicates = await Promise.all(Array.from({ length: 20 }, () => AppUsage.recordOpen(1)));
      assert.equal(duplicates.filter(r => r.recorded).length, 0);
      assert.equal(await AppUsage.recordOpen(2), null);
    });
    await t.test('最後の利用から60分で区切り、同日複数SessionでもActive Dayは1日', async () => {
      now = '2026-09-22T01:59:59Z';
      assert.equal((await AppUsage.recordOpen(1)).recorded, false);
      now = '2026-09-22T02:59:58Z';
      assert.equal((await AppUsage.recordOpen(1)).recorded, false);
      now = '2026-09-22T03:59:58Z';
      assert.equal((await AppUsage.recordOpen(1)).recorded, true);
      assert.equal((await query('SELECT COUNT(*)::integer AS count FROM portal_active_days')).rows[0].count, 1);
    });
    await t.test('月跨ぎの同一Sessionでも翌日のActive Dayを記録し、月別集計は混ざらない', async () => {
      now = '2026-09-30T14:50:00Z'; // 23:50 JST
      assert.equal((await AppUsage.recordOpen(1)).recorded, true);
      now = '2026-09-30T15:10:00Z'; // 00:10 JST, same session
      assert.equal((await AppUsage.recordOpen(1)).recorded, false);
      await Promise.all(Array.from({ length: 20 }, () => AppUsage.recordOpen(1)));
      const days = (await query('SELECT activity_date::text FROM portal_active_days ORDER BY activity_date')).rows;
      assert.deepEqual(days.map(d => d.activity_date), ['2026-09-22', '2026-09-30', '2026-10-01']);
      assert.equal((await query("SELECT COUNT(*)::integer AS count FROM app_usage_daily WHERE usage_date='2026-10-01'")).rows[0].count, 0);
      const realQuery = db.query;
      db.query = (sql, params) => query(sql.replaceAll('CURRENT_TIMESTAMP', "TIMESTAMPTZ '2026-09-30T15:10:00Z'"), params);
      try {
        const student = (await Progress.getAllUsersProgress()).find(u => u.id === 1);
        assert.equal(student.active_today, true);
        assert.equal(student.monthly_active_days, 1);
        assert.equal(student.daily_usage_count, 0);
        const summary = await Progress.getAllUsersProgressSummary();
        assert.equal(summary.daily_active_students, 1);
        assert.equal(summary.monthly_active_student_days, 1);
      } finally { db.query = realQuery; }
      now = null;
    });
    await t.test('旧利用記録を持つ生徒の移行直後は重複しない', async () => {
      await query(`INSERT INTO app_usage_daily(user_id, usage_date, open_count, last_opened_at)
        VALUES (3, (NOW() AT TIME ZONE 'Asia/Tokyo')::date, 8, NOW())`);
      assert.equal((await AppUsage.recordOpen(3)).recorded, false);
    });
    await t.test('70分の継続再生・同時イベント・日跨ぎは1Session、60分無操作は新Session', async () => {
      await query('BEGIN');
      try {
        now = '2026-11-01T11:00:00Z'; // 20:00 JST
        assert.equal((await AppUsage.recordOpen(1)).recorded, true);
        now = '2026-11-01T11:30:00Z';
        await AppUsage.recordActivity(1);
        now = '2026-11-01T12:00:00Z';
        await AppUsage.recordActivity(1);
        now = '2026-11-01T12:10:00Z';
        const mixed = await Promise.all([AppUsage.recordActivity(1), AppUsage.recordOpen(1), AppUsage.recordOpen(1)]);
        assert.equal(mixed[1].recorded, false);
        assert.equal(mixed[2].recorded, false);
        assert.equal((await query("SELECT open_count FROM app_usage_daily WHERE user_id=1 AND usage_date='2026-11-01'")).rows[0].open_count, 1);
        now = '2026-11-01T13:11:00Z';
        await AppUsage.recordActivity(1); // Stale playback cannot revive an expired session.
        assert.equal((await AppUsage.recordOpen(1)).recorded, true);
        now = '2026-11-01T14:50:00Z';
        await AppUsage.recordOpen(1);
        now = '2026-11-01T15:10:00Z';
        await Promise.all([AppUsage.recordActivity(1), AppUsage.recordActivity(1), AppUsage.recordActivity(2)]);
        assert.equal((await query("SELECT COUNT(*)::integer AS n FROM portal_active_days WHERE activity_date='2026-11-02'")).rows[0].n, 1);
        assert.equal((await query("SELECT COUNT(*)::integer AS n FROM app_usage_daily WHERE usage_date='2026-11-02'")).rows[0].n, 0);
      } finally { now = null; await query('ROLLBACK'); }
    });
    await pg.exec(`INSERT INTO courses(id,title,order_index,sequential_unlock) VALUES (1,'対象',1,true);
      INSERT INTO lessons(id,course_id,title,order_index,content_type) VALUES
        (1,1,'動画',1,'video'), (2,1,'クイズなし',2,'link');
      INSERT INTO quiz_questions(lesson_id,question,options,correct_answer)
        VALUES (1,'問題','["a","b","c"]',0)`);
    await t.test('再生とクイズを分離・不合格→合格・教材解放・クイズなし完了', async () => {
      await Progress.recordView(1, 1);
      await Progress.recordView(1, 1);
      await Progress.updateWatchPercent(1, 1, 96);
      assert.equal(await Progress.canAccessLesson(1, 2), false);
      await Progress.completeQuiz(1, 1, false);
      assert.equal(await Progress.canAccessLesson(1, 2), false);
      const passed = await Progress.completeQuiz(1, 1, true);
      assert.equal(passed.quiz_attempts, 2);
      assert.equal(passed.quiz_failed_attempts, 1);
      assert.equal(passed.watch_percent, 96);
      assert.equal(passed.view_count, 2);
      assert.equal(await Progress.canAccessLesson(1, 2), true);
      assert.equal((await Progress.completeByWatching(1, 2)).completed, true);
      const detail = await LearningAnalytics.forStudent(1);
      assert.equal(detail.overall.quiz_attempts, 2);
      assert.equal(detail.overall.quiz_attempt_pass_rate, 50);
      const old = await Progress.completeQuiz(3, 1, false);
      await query('UPDATE user_progress SET quiz_failed_attempts=NULL WHERE user_id=3');
      const legacy = await Progress.completeQuiz(3, 1, true);
      assert.equal(old.quiz_attempts, 1);
      assert.equal(legacy.quiz_failed_attempts, null);
    });
    await t.test('既存の日次・月次集計SQLとページングを維持', async () => {
      const users = await Progress.getAllUsersProgress({ limit: 1, offset: 0 });
      assert.equal(users.length, 1);
      const summary = await Progress.getAllUsersProgressSummary();
      assert.equal(summary.total_students, 2);
      const total = (await query(`SELECT SUM(open_count)::integer AS total FROM app_usage_daily
        WHERE usage_date >= DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Tokyo')::date`)).rows[0].total;
      assert.equal(summary.monthly_usage_count, total);
      const daily = (await query(`SELECT SUM(open_count)::integer AS total FROM app_usage_daily
        WHERE usage_date = (NOW() AT TIME ZONE 'Asia/Tokyo')::date`)).rows[0].total;
      assert.equal(summary.daily_usage_count, daily || 0);
    });
    await pg.exec(`INSERT INTO notion_students(notion_page_id, student_number, student_name,lesson_start_month)
      VALUES ('page-1',' ST-01 ','別表記','2020-01-01');
      INSERT INTO student_profiles(user_id,notion_page_id,lesson_start_date)
      VALUES (1,'page-1','2020-01-02') ON CONFLICT(user_id) DO UPDATE SET
        notion_page_id=EXCLUDED.notion_page_id, lesson_start_date=EXCLUDED.lesson_start_date`);
    const paymentRows = status => {
      const header = Array(19).fill('');
      header[18] = sheet.previousMonth().slice(0, 7).replace('-', '/');
      const row = Array(19).fill('');
      row[3] = ' ST-01 '; row[18] = status;
      return [header, row];
    };
    await t.test('初回同期前は全員拒否しない・Notion番号と具体的開始日優先', async () => {
      assert.equal((await StudentPayment.getAccess(1, '生徒')).allowed, true);
      const result = await StudentPayment.synchronize(async () => paymentRows('支払い完了'));
      assert.equal(result.updated, 1);
      assert.ok(result.issues.some(i => i.code === 'missing_student_number'));
      const detail = await StudentPayment.getDetail(1);
      assert.equal(detail.student_number, 'ST-01');
      assert.equal(detail.lesson_start_date, '2020-01-02');
      assert.equal(detail.is_paid, true);
      assert.equal(detail.access.allowed, true);
    });
    await t.test('開始日9/20を開始月9/1より優先・当日の支払い判定・NULL時fallback', async () => {
      const originalDate = sheet.japanDate;
      await query('BEGIN');
      try {
        await query("UPDATE student_profiles SET lesson_start_date='2026-09-20' WHERE user_id=1");
        await query("UPDATE notion_students SET lesson_start_month='2026-09-01' WHERE notion_page_id='page-1'");
        await query('UPDATE student_payment_status SET is_paid=false WHERE user_id=1');
        sheet.japanDate = () => '2026-09-19';
        const before = await StudentPayment.getDetail(1);
        assert.equal(before.lesson_start_date, '2026-09-20');
        assert.deepEqual(before.access, { allowed: true, reason: 'before_start' });
        sheet.japanDate = () => '2026-09-20';
        assert.deepEqual((await StudentPayment.getDetail(1)).access, { allowed: false, reason: 'payment_required' });
        await query('UPDATE student_payment_status SET is_paid=true WHERE user_id=1');
        assert.deepEqual((await StudentPayment.getDetail(1)).access, { allowed: true, reason: 'paid' });
        await query('UPDATE student_profiles SET lesson_start_date=NULL WHERE user_id=1');
        assert.equal((await StudentPayment.getDetail(1)).lesson_start_date, '2026-09-01');
      } finally { sheet.japanDate = originalDate; await query('ROLLBACK'); }
    });
    await t.test('API障害・列不明・重複でも既存正常データを維持', async () => {
      const before = (await query('SELECT * FROM student_payment_status')).rows;
      await assert.rejects(StudentPayment.synchronize(async () => { throw new Error('network'); }), /payment_sync_failed/);
      await assert.rejects(StudentPayment.synchronize(async () => [['bad']]), /missing_month_header/);
      const duplicate = paymentRows('未払い（遅れ）'); duplicate.push([...duplicate[1]]);
      await StudentPayment.synchronize(async () => duplicate);
      assert.deepEqual((await query('SELECT * FROM student_payment_status')).rows, before);
      assert.equal((await StudentPayment.getDetail(1)).issue, 'duplicate');
      assert.equal((await StudentPayment.getAccess(1, '生徒')).allowed, true);
    });
    await t.test('支払い未完了を同期後に拒否・見つからない番号はnot_found', async () => {
      await StudentPayment.synchronize(async () => paymentRows('未払い（遅れ）'));
      assert.equal((await StudentPayment.getAccess(1, '生徒')).allowed, false);
      const absent = paymentRows('支払い完了'); absent[1][3] = 'OTHER';
      await StudentPayment.synchronize(async () => absent);
      assert.equal((await StudentPayment.getDetail(1)).issue, 'not_found');
    });
    await t.test('直接API・メディアは拒否、スタッフとflag=falseは許可', async () => {
      const express = require('express');
      const jwt = require('jsonwebtoken');
      const app = express();
      app.use(express.json());
      for (const route of ['lessons', 'progress', 'portal', 'usage', 'characters', 'students']) {
        app.use('/api/' + route, require('../src/routes/' + route));
      }
      app.get('/uploads/test', require('../src/middleware/portalAccess').protectMedia, (req, res) => res.sendStatus(200));
      process.env.JWT_SECRET = 'isolated-verification-key';
      const token = jwt.sign({ id: 1, role: '生徒' }, process.env.JWT_SECRET);
      const staff = jwt.sign({ id: 2, role: '管理者' }, process.env.JWT_SECRET);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      try {
        for (const path of ['/api/lessons', '/api/progress', '/api/portal/links', '/api/characters/me',
          '/api/students/1/schedule/week']) {
          const response = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
          assert.equal(response.status, 403, path);
          assert.equal((await response.json()).code, 'PAYMENT_REQUIRED');
        }
        assert.equal((await fetch(base + '/uploads/test')).status, 401);
        assert.equal((await fetch(base + '/uploads/test', { headers: { Cookie: 'portal_media=' + token } })).status, 403);
        const usageResponse = await fetch(base + '/api/usage/open', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token }
        });
        assert.equal(usageResponse.status, 403);
        assert.equal((await fetch(base + '/api/portal/links', { headers: { Authorization: 'Bearer ' + staff } })).status, 200);
        process.env.PAYMENT_ACCESS_CONTROL_ENABLED = 'false';
        assert.equal((await fetch(base + '/api/portal/links', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
        const savedActivity = AppUsage.recordActivity;
        const activityCalls = [];
        AppUsage.recordActivity = async id => activityCalls.push(id);
        try {
          const sendProgress = (body, jwtToken = token, id = 1) => fetch(base + '/api/lessons/' + id + '/watch-progress', {
            method: 'POST', headers: { Authorization: 'Bearer ' + jwtToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          assert.equal((await sendProgress({ percent: 50, playbackActive: true })).status, 200);
          assert.deepEqual(activityCalls, [1]);
          for (const value of [false, undefined, 'true']) {
            assert.equal((await sendProgress({ percent: 55, playbackActive: value })).status, 200);
          }
          assert.equal((await sendProgress({ percent: 60, playbackActive: true }, staff)).status, 200);
          assert.equal((await sendProgress({ percent: 60, playbackActive: true }, token, 2)).status, 200); // Link, not video
          assert.equal((await sendProgress({ percent: 'bad', playbackActive: true })).status, 400);
          assert.deepEqual(activityCalls, [1]);
        } finally { AppUsage.recordActivity = savedActivity; }
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await pg.close();
  }
});
