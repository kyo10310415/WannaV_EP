const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const db = require('../src/config/database');
const axios = require('axios');
const { SocialMetrics, weekStart, historyStart, accountKey, validId, countValue } = require('../src/models/SocialMetrics');
const { parsePage } = require('../src/utils/notionSync');

test('SNSの週・履歴期間は日本時間と月末に対応する', () => {
  assert.equal(weekStart(new Date('2026-10-04T14:59:00Z')), '2026-09-28');
  assert.equal(weekStart(new Date('2026-10-04T15:00:00Z')), '2026-10-05');
  assert.equal(historyStart(new Date('2026-04-30T00:00:00Z')), '2026-02-28');
  assert.equal(historyStart(new Date('2026-01-01T00:00:00Z')), '2025-11-01');
  assert.equal(accountKey('x', ' @Samusou_Nayuki '), 'samusou_nayuki');
  assert.equal(validId('youtube', 'UCirYSfJBd5e4WK2SmmOFunA'), true);
  assert.equal(validId('x', 'https://x.com/example'), false);
  assert.equal(countValue('0'), 0);
  assert.equal(countValue(undefined), null);
  assert.equal(countValue('-1'), null);
});

test('Notionの指定プロパティを取り込み、IDの空欄を区別する', () => {
  const page = { id: 'test', properties: {
    'X ID（@は無し）': { type: 'rich_text', rich_text: [{ plain_text: ' Samusou_Nayuki ' }] },
    'YTチャンネルID': { type: 'rich_text', rich_text: [{ plain_text: 'UCirYSfJBd5e4WK2SmmOFunA' }] },
  } };
  assert.equal(parsePage(page).xUsername, 'Samusou_Nayuki');
  assert.equal(parsePage(page).youtubeChannelId, 'UCirYSfJBd5e4WK2SmmOFunA');
  assert.equal(parsePage({ id: 'empty' }).xUsername, null);
});

test('グラフは0人を表示し、欠測週を繋がず、IDをHTMLエスケープする', () => {
  const context = { window: {}, Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/social-metrics.js'), 'utf8'), context);
  const container = {};
  const now = new Date();
  const points = [28, 7].map(days => {
    const date = new Date(now.getTime() - days * 86400000);
    return { weekStart: weekStart(date), count: 0, fetchedAt: date.toISOString() };
  });
  const metric = { accountId: '<script>bad</script>', status: 'ok', count: 0, fetchedAt: now.toISOString(), history: points };
  context.window.SocialMetricsWidget.render(container, {
    weekStart: weekStart(now), fromDate: historyStart(now), platforms: { x: metric, youtube: metric }
  });
  assert.match(container.innerHTML, /0<span> 人/);
  assert.doesNotMatch(container.innerHTML, /<script>bad/);
  const pathData = container.innerHTML.match(/<path d="([^"]+)"/)[1];
  assert.equal((pathData.match(/M/g) || []).length, 2);
});

test('SNS週次保存・再取得抑止・30日制限・生徒別権限を隔離PostgreSQLで確認', {
  skip: !process.env.PGLITE_TEST_MODULE
}, async t => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const pg = new PGlite();
  const originalQuery = db.query, originalConnect = db.pool.connect, originalGet = axios.get;
  const oldEnv = { ...process.env };
  db.query = (sql, params) => pg.query(sql, params);
  db.pool.connect = async () => ({ query: db.query, release() {} });
  const yt = 'UCirYSfJBd5e4WK2SmmOFunA';
  const yt2 = 'UC' + 'b'.repeat(22);
  process.env.X_BEARER_TOKEN = 'isolated-x-token';
  process.env.YOUTUBE_API_KEY = 'isolated-youtube-key';
  process.env.PAYMENT_ACCESS_CONTROL_ENABLED = 'false';
  process.env.JWT_SECRET = 'isolated-social-test-secret';
  const calls = [];
  axios.get = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('api.x.com')) return { data: { data: options.params.usernames.split(',').map(username =>
      ({ username, public_metrics: { followers_count: username === 'other' ? 0 : 1234 } })) } };
    return { data: { items: options.params.id.split(',').map(id =>
      ({ id, statistics: { subscriberCount: id === yt2 ? '0' : '4560', hiddenSubscriberCount: false } })) } };
  };
  try {
    await require('../src/models/schema').createTables();
    await require('../src/models/schema').createTables();
    await db.query(`INSERT INTO users(id,email,password,name,username,role,password_changed_at) VALUES
      (1,'s1@test','x','生徒1','s1','生徒',NOW()),(2,'admin@test','x','管理者','admin','管理者',NOW()),
      (3,'crew@test','x','クルー','crew','クルー',NOW()),(4,'sales@test','x','セールス','sales','セールス',NOW()),
      (5,'s2@test','x','生徒2','s2','生徒',NOW())`);
    const entries = [
      { notionPageId: 'page1', studentName: '生徒1', xUsername: 'Samusou_Nayuki', youtubeChannelId: yt },
      { notionPageId: 'page2', studentName: '生徒2', xUsername: 'other', youtubeChannelId: yt2 },
      { notionPageId: 'page3', studentName: '未作成', xUsername: 'samusou_nayuki', youtubeChannelId: yt },
      { notionPageId: 'invalid', studentName: '不正', xUsername: 'https://x.com/bad' },
    ].map(entry => ({ ...entry, contractPlan: 'エントリープラン' }));
    await require('../src/models/NotionStudent').upsertMany(entries);
    await db.query(`INSERT INTO student_profiles(user_id, notion_page_id, assigned_tutor_id)
      VALUES (1,'page1',3),(5,'page2',NULL)`);

    await t.test('まとめて取得し、成功済みの週は再取得しない', async () => {
      await SocialMetrics.synchronize();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].options.params.usernames.split(',').length, 2);
      assert.equal(calls[1].options.params.id.split(',').length, 2);
      await SocialMetrics.synchronize();
      assert.equal(calls.length, 2);
      const data = await SocialMetrics.forPage('page1');
      assert.equal(data.platforms.x.count, 1234);
      assert.equal(data.platforms.youtube.count, 4560);
      assert.equal((await SocialMetrics.forPage('page2')).platforms.x.count, 0);
      assert.equal((await SocialMetrics.forPage('invalid')).platforms.x.status, 'invalid_id');
    });
    await t.test('YouTubeの古い数値は表示・保存対象から外し、ID変更で履歴を混ぜない', async () => {
      const old = new Date(Date.now() - 40 * 86400000);
      await db.query(`INSERT INTO student_social_snapshots(notion_page_id,platform,account_key,week_start,count,status,fetched_at)
        VALUES ('page1','youtube',$1,$2,100,'ok',$3),('page1','x','samusou_nayuki',$2,100,'ok',$3)`,
      [yt, weekStart(old), old.toISOString()]);
      const data = await SocialMetrics.forPage('page1');
      assert.equal(data.platforms.youtube.history.length, 1);
      assert.equal(data.platforms.x.history.length, 2);
      await SocialMetrics.synchronize();
      assert.equal((await db.query("SELECT COUNT(*)::integer n FROM student_social_snapshots WHERE platform='youtube' AND fetched_at < NOW() - INTERVAL '30 days'")).rows[0].n, 0);
      await db.query("UPDATE notion_students SET x_username = 'changed' WHERE notion_page_id = 'page3'");
      assert.equal((await SocialMetrics.forPage('page3')).platforms.x.history.length, 0);
    });
    await t.test('失敗を0人にせず、成功履歴を失敗結果で上書きしない', async () => {
      const errorLog = console.error;
      const logs = [];
      console.error = (...args) => logs.push(args.join(' '));
      axios.get = async () => { throw { response: { status: 429 }, config: { key: 'isolated-youtube-key' } }; };
      try {
        await SocialMetrics.synchronize();
        const data = await SocialMetrics.forPage('page3');
        assert.equal(data.platforms.x.status, 'api_error');
        assert.equal(data.platforms.x.count, null);
        await SocialMetrics.save([{ notion_page_id: 'page1', platform: 'x', account_key: 'samusou_nayuki',
          week_start: weekStart(), count: null, status: 'api_error' }]);
        assert.equal((await SocialMetrics.forPage('page1')).platforms.x.count, 1234);
        assert.doesNotMatch(logs.join(' '), /isolated-youtube-key/);
      } finally { console.error = errorLog; }
    });
    await t.test('生徒は自分だけ、クルーは担当生徒だけ、管理者は未作成生徒も閲覧できる', async () => {
      const express = require('express'), jwt = require('jsonwebtoken');
      const app = express();
      app.use('/api/social-metrics', require('../src/routes/socialMetrics'));
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = 'http://127.0.0.1:' + server.address().port + '/api/social-metrics';
      const call = (path, id, role) => fetch(base + path, { headers: { Authorization: 'Bearer ' + jwt.sign({ id, role }, process.env.JWT_SECRET) } });
      try {
        assert.equal((await fetch(base + '/me')).status, 401);
        const own = await call('/me?userId=5', 1, '生徒');
        assert.equal(own.headers.get('cache-control'), 'private, no-store');
        assert.equal((await own.json()).data.studentName, '生徒1');
        assert.equal((await call('/student?notionPageId=page2', 1, '生徒')).status, 403);
        assert.equal((await call('/student?notionPageId=page1', 3, 'クルー')).status, 200);
        assert.equal((await call('/student?notionPageId=page2', 3, 'クルー')).status, 403);
        assert.equal((await call('/student?userId=5', 3, 'クルー')).status, 403);
        assert.equal((await call('/student?notionPageId=page3', 2, '管理者')).status, 200);
        assert.equal((await call('/student?notionPageId=page1', 4, 'セールス')).status, 403);
        assert.equal((await call('/student?userId=-1', 2, '管理者')).status, 400);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await t.test('Notionなしのtest_seitoだけ手動設定し、同じ週次処理と生徒画面で表示する', async () => {
      await db.query(`INSERT INTO users(id,email,password,name,username,role)
        VALUES (6,'test@example.invalid','unused','テスト生徒','test_seito','生徒')`);
      const express = require('express'), jwt = require('jsonwebtoken');
      const app = express();
      app.use(express.json());
      app.use('/api/social-metrics', require('../src/routes/socialMetrics'));
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = 'http://127.0.0.1:' + server.address().port + '/api/social-metrics';
      const call = (path, id, role, body) => fetch(base + path, {
        method: body ? 'PUT' : 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ id, role }, process.env.JWT_SECRET) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const synchronize = SocialMetrics.synchronize;
      let triggered = 0;
      SocialMetrics.synchronize = async () => { triggered++; };
      try {
        const ids = { xUsername: '@Samusou_Nayuki', youtubeChannelId: yt };
        assert.equal((await call('/test-account', 6, '生徒', ids)).status, 403);
        assert.equal((await call('/test-account', 4, 'セールス', ids)).status, 403);
        assert.equal((await call('/test-account', 2, '管理者', { ...ids, youtubeChannelId: 'bad' })).status, 400);
        assert.equal((await call('/test-account', 2, '管理者', ids)).status, 200);
        assert.equal(triggered, 1);
        const config = await (await call('/test-account', 2, '管理者')).json();
        assert.equal(config.xUsername, 'samusou_nayuki');
        axios.get = async url => url.includes('api.x.com')
          ? { data: { data: [{ username: 'samusou_nayuki', public_metrics: { followers_count: 1234 } }] } }
          : { data: { items: [{ id: yt, statistics: { subscriberCount: '4560' } }] } };
        await synchronize.call(SocialMetrics);
        const own = await (await call('/me', 6, '生徒')).json();
        assert.equal(own.data.studentName, 'テスト生徒');
        assert.equal(own.data.platforms.x.count, 1234);
        assert.equal(own.data.platforms.youtube.count, 4560);
        assert.equal((await SocialMetrics.forUser(5)), null);
        assert.equal((await db.query("SELECT count(*)::integer n FROM notion_students WHERE notion_page_id LIKE 'manual:%'")).rows[0].n, 0);
        await db.query("INSERT INTO student_profiles(user_id,notion_page_id) VALUES (6,'page1')");
        assert.equal((await call('/test-account', 2, '管理者', ids)).status, 404);
        assert.equal(await SocialMetrics.forUser(6), null);
      } finally {
        SocialMetrics.synchronize = synchronize;
        await new Promise(resolve => server.close(resolve));
      }
    });
  } finally {
    db.query = originalQuery; db.pool.connect = originalConnect; axios.get = originalGet;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await pg.close();
  }
});
