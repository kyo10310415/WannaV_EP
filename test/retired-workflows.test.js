const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('廃止ページ・API・自動ジョブ・各画面のリンクが残らない', () => {
  for (const file of ['views/admin-handovers.html', 'views/admin-extensions.html',
    'src/models/HandoverInfo.js', 'src/models/ExtensionReview.js']) {
    assert.equal(fs.existsSync(path.join(root, file)), false);
  }
  const router = require('../src/routes/students');
  for (const layer of router.stack) {
    if (layer.route) assert.doesNotMatch(layer.route.path, /handover|extension/);
  }
  assert.doesNotMatch(read('server.js'), /\/admin\/(handovers|extensions)/);
  assert.doesNotMatch(read('src/utils/scheduler.js'), /extension_reviews|scheduleAutoCreateExtensionReviews/);
  for (const file of fs.readdirSync(path.join(root, 'views')).filter(f => f.endsWith('.html'))) {
    assert.doesNotMatch(read('views/' + file), /\/admin\/(handovers|extensions)|accountActions/);
  }
  assert.doesNotMatch(read('views/admin-users.html'), /契約アクティブ|総生徒数/);
  assert.match(read('views/admin-users.html'), /アクティブ生徒数/);
  assert.match(read('views/admin-users.html'), /onclick="openCourseProgress/);
});

test('コース別進捗は読込・割合・空データ・失敗を表示し、コース名をエスケープする', async () => {
  const dialog = { open: false, showModal() { this.open = true; } };
  const body = { textContent: '', innerHTML: '' };
  let payload = { learning: { courses: [
    { title: '<必須科目>', special: false, kpi: { completed: 1, total: 2, completion_rate: 50 } },
    { title: '対象外', special: true, kpi: { completed: 1, total: 1, completion_rate: 100 } }
  ] } };
  let ok = true;
  const context = {
    window: {}, localStorage: { getItem: () => 'test-token' },
    document: { getElementById: id => id === 'analytics-dialog' ? dialog : body },
    fetch: async () => ({ ok, json: async () => payload })
  };
  vm.runInNewContext(read('public/js/admin-analytics.js'), context);
  await context.window.openCourseProgress(1);
  assert.equal(dialog.open, true);
  assert.match(body.innerHTML, /&lt;必須科目&gt;/);
  assert.match(body.innerHTML, /50%/);
  assert.doesNotMatch(body.innerHTML, /対象外/);
  payload = { learning: { courses: [] } };
  await context.window.openCourseProgress(1);
  assert.match(body.innerHTML, /対象のコースはありません/);
  ok = false;
  await context.window.openCourseProgress(1);
  assert.match(body.textContent, /情報を取得できません/);
});
