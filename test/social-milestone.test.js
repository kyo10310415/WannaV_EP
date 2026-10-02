const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const db = require('../src/config/database');
const { SocialMilestone, milestone } = require('../src/models/SocialMilestone');
const { SocialMetrics } = require('../src/models/SocialMetrics');

test('100、1000、10000の境界と人数ジャンプは最新の節目になる', () => {
  for (const [count, expected] of [[0,0],[99,0],[100,100],[899,800],[900,900],[999,900],
    [1000,1000],[2300,2000],[9999,9000],[10000,10000],[29999,20000],[30000,30000]]) {
    assert.equal(milestone(count), expected);
  }
  assert.equal(milestone(NaN), 0);
});

test('管理者の演出プレビューは繰り返せて、SNS API・達成履歴へ通信しない', async () => {
  const titles = [];
  let fetches = 0;
  const context = {
    window: {}, matchMedia: () => ({ matches: true }), cancelAnimationFrame() {},
    fetch() { fetches++; throw new Error('Preview must not fetch'); },
    document: { querySelector: () => null, body: { append() {} }, createElement(tag) {
      const handlers = {};
      return { setAttribute() {}, append() {}, focus() {}, remove() {},
        addEventListener(name, fn) { handlers[name] = fn; },
        showModal() { queueMicrotask(() => handlers.close()); },
        set textContent(text) { if (tag === 'h2') titles.push(text); }
      };
    } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/social-celebration.js'), 'utf8'), context);
  const preview = context.window.SocialCelebration.preview;
  for (const role of ['生徒', 'セールス', 'クルー']) await preview({ role }, 'x', 100);
  await preview({ role: '管理者' }, 'bad', 100);
  await preview({ role: '管理者' }, 'x', 200);
  assert.equal(titles.length, 0);
  for (const threshold of [100, 1000, 10000, 100]) await preview({ role: '管理者' }, 'youtube', threshold);
  assert.equal(titles.length, 4);
  assert.equal(titles[0], 'YouTubeの登録者数が100人達成しました！');
  assert.equal(fetches, 0);
  const html = fs.readFileSync(require.resolve('../views/admin-students-accounts.html'), 'utf8');
  assert.match(html, /id="celebration-preview" hidden/);
  assert.match(html, /hidden = user.role !== '管理者'/);
});

test('生徒だけに一度開始し、同時達成は順番に表示、特別な節目に特別な文章を使う', async () => {
  const elements = [], calls = [];
  function element(tag) {
    const handlers = {};
    const el = { tag, children: [], className: '', textContent: '',
      append(...children) { this.children.push(...children); },
      setAttribute() {}, addEventListener(name, handler) { handlers[name] = handler; },
      focus() {}, remove() {},
      showModal() { queueMicrotask(() => handlers.close()); },
      close() { handlers.close(); } };
    elements.push(el); return el;
  }
  const context = {
    document: { visibilityState: 'visible', querySelector: () => null, createElement: element, body: { append() {} } },
    localStorage: { getItem: () => 'fake-token' },
    setTimeout: fn => fn(), cancelAnimationFrame() {},
    matchMedia: () => ({ matches: true }),
    fetch: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ celebrations: [{ platform: 'x', threshold: 1000 }, { platform: 'youtube', threshold: 10000 }] }) };
    }, window: {}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/social-celebration.js'), 'utf8'), context);
  await context.window.SocialCelebration.start({ role: '管理者' });
  await context.window.SocialCelebration.start({ role: '生徒', needsPasswordChange: true });
  assert.equal(calls.length, 0);
  await context.window.SocialCelebration.start({ role: '生徒' });
  await context.window.SocialCelebration.start({ role: '生徒' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(elements.filter(el => el.tag === 'h2').map(el => el.textContent),
    ['Xのフォロワー数が1,000人達成しました！', 'YouTubeの登録者数が10,000人達成しました！']);
  assert.equal(elements.filter(el => el.tag === 'dialog' && el.className.includes('special')).length, 2);
  assert.ok(elements.some(el => el.textContent.includes('新しい景色')));
  assert.ok(elements.some(el => el.textContent.includes('思いきり誇って')));
});

test('初回基準・最新達成・再表示防止・ID変更・30日期限・本人権限をPostgreSQLで確認', {
  skip: !process.env.PGLITE_TEST_MODULE
}, async () => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const pg = new PGlite();
  const originalQuery = db.query, originalConnect = db.pool.connect;
  const savedEnv = { ...process.env };
  db.query = (sql, params) => pg.query(sql, params);
  db.pool.connect = async () => ({ query: db.query, release() {} });
  process.env.PAYMENT_ACCESS_CONTROL_ENABLED = 'false';
  process.env.JWT_SECRET = 'milestone-test-only';
  let server;
  try {
    await require('../src/models/schema').createTables();
    await require('../src/models/schema').createTables();
    await db.query(`INSERT INTO users(id,email,password,name,username,role,password_changed_at) VALUES
      (1,'one@test','x','生徒1','one','生徒',NOW()),(2,'two@test','x','生徒2','two','生徒',NOW()),
      (3,'admin@test','x','管理者','admin','管理者',NOW()),(4,'test@test','x','テスト','test_seito','生徒',NOW())`);
    await db.query(`INSERT INTO notion_students(notion_page_id,student_name,x_username,youtube_channel_id)
      VALUES ('one','生徒1','example','UCirYSfJBd5e4WK2SmmOFunA'),('two','生徒2','other',NULL)`);
    await db.query(`INSERT INTO student_profiles(user_id,notion_page_id) VALUES (1,'one'),(2,'two')`);
    const yt = 'UCirYSfJBd5e4WK2SmmOFunA';
    const record = (count, platform = 'x', account = 'example', source = 'one') => ({
      notion_page_id: source, platform, account_key: account, count, status: 'ok', week_start: '2026-09-07'
    });
    // Use real snapshot save so the snapshot and celebration update are tested together.
    await SocialMetrics.save([record(3500), record(3500, 'youtube', yt)]);
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMetrics.save([ { ...record(9300), week_start: '2026-09-14' },
      { ...record(10000, 'youtube', yt), week_start: '2026-09-14' } ]);
    assert.deepEqual(await SocialMilestone.claim(2), []);
    const results = await Promise.all([SocialMilestone.claim(1), SocialMilestone.claim(1)]);
    assert.equal(results.flat().length, 2);
    assert.deepEqual(results.flat().map(e => e.threshold).sort((a,b) => a-b), [9000,10000]);
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMilestone.record([record(8000)]);
    await SocialMilestone.record([record(9300)]);
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMilestone.record([ { ...record(null), status: 'api_error' } ]);
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMilestone.record([record(10000)]);
    await db.query("UPDATE notion_students SET x_username='changed' WHERE notion_page_id='one'");
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMilestone.record([record(800, 'x', 'changed')]);
    await SocialMilestone.record([record(1000, 'x', 'changed')]);
    assert.deepEqual(await SocialMilestone.claim(1), [{ platform: 'x', threshold: 1000 }]);
    await SocialMilestone.record([record(20000,'youtube',yt)]);
    await db.query("UPDATE social_milestone_state SET pending_at=NOW()-INTERVAL '31 days' WHERE platform='youtube'");
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await db.query("UPDATE social_milestone_state SET high_water_at=NOW()-INTERVAL '31 days' WHERE platform='youtube'");
    await SocialMilestone.record([record(800,'youtube',yt)]);
    assert.deepEqual(await SocialMilestone.claim(1), []);
    await SocialMilestone.record([record(900,'youtube',yt)]);
    assert.deepEqual(await SocialMilestone.claim(1), [{ platform: 'youtube', threshold: 900 }]);
    await db.query(`INSERT INTO test_student_social_accounts(notion_page_id,user_id,x_username) VALUES ('manual:4',4,'manual')`);
    await SocialMilestone.record([record(0,'x','manual','manual:4')]);
    await SocialMilestone.record([record(100,'x','manual','manual:4')]);
    assert.deepEqual(await SocialMilestone.claim(4), [{ platform: 'x', threshold: 100 }]);
    await SocialMilestone.record([record(2000,'x','changed'),record(1000,'youtube',yt)]);
    assert.deepEqual(await SocialMilestone.claim(1,'x'), [{ platform: 'x', threshold: 2000 }]);
    assert.deepEqual(await SocialMilestone.claim(1,'youtube'), [{ platform: 'youtube', threshold: 1000 }]);

    const normalQuery = db.query;
    db.query = (sql, params) => sql.startsWith('INSERT INTO social_milestone_state')
      ? Promise.reject(new Error('simulated milestone failure')) : normalQuery(sql, params);
    try {
      await assert.rejects(SocialMetrics.save([{ ...record(3000,'x','changed'), week_start:'2026-09-21' }]), /simulated/);
    } finally { db.query = normalQuery; }
    assert.equal((await db.query("SELECT count(*)::integer n FROM student_social_snapshots WHERE week_start='2026-09-21'")).rows[0].n, 0);

    const express = require('express'), jwt = require('jsonwebtoken');
    const app = express();
    app.use(express.json());
    app.use('/api/social-metrics', require('../src/routes/socialMetrics'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/social-metrics/milestones/claim';
    const call = (id, role) => fetch(url + '?userId=1', { method: 'POST', headers: {
      Authorization: 'Bearer ' + jwt.sign({ id, role }, process.env.JWT_SECRET)
    } });
    await SocialMilestone.record([record(3000,'x','changed')]);
    assert.equal((await call(3,'管理者')).status, 403);
    assert.deepEqual((await (await call(2,'生徒')).json()).celebrations, []);
    assert.deepEqual((await (await call(1,'生徒')).json()).celebrations, [{ platform: 'x', threshold: 3000 }]);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.query = originalQuery; db.pool.connect = originalConnect;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await pg.close();
  }
});
