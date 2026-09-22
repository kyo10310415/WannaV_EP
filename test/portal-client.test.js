const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function browser() {
  let time = 100000;
  const events = new Map();
  const calls = [];
  const add = (name, listener) => events.set(name, listener);
  const context = {
    Date: class extends Date { static now() { return time; } },
    document: { visibilityState: 'visible', addEventListener: add },
    addEventListener: add,
    localStorage: { getItem: () => 'test-token' },
    fetch: async (...args) => { calls.push(args); return { status: 201 }; },
    URL, location: { origin: 'https://test.invalid' }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/portal-session.js'), 'utf8'), context);
  return { context, calls, events, advance(ms) { time += ms; } };
}
test('非表示タブ・スタッフでは記録せず、復帰時に1回のみ送信', async () => {
  const b = browser();
  b.context.document.visibilityState = 'hidden';
  b.context.PortalSession.start({ role: '生徒' });
  assert.equal(b.calls.length, 0);
  b.context.document.visibilityState = 'visible';
  await Promise.all(['visibilitychange', 'pageshow', 'focus', 'pointerdown'].map(name => b.events.get(name)()));
  assert.equal(b.calls.length, 1);
  b.advance(6 * 3600000);
  assert.equal(b.calls.length, 1); // Advancing the clock alone never sends traffic.
  await b.events.get('keydown')();
  assert.equal(b.calls.length, 2);
  const staff = browser();
  staff.context.PortalSession.start({ role: '管理者' });
  assert.equal(staff.calls.length, 0);
});
test('再初期化でイベントを重複登録せず、初回PW変更前は記録しない', async () => {
  const b = browser();
  b.context.PortalSession.start({ role: '生徒', needsPasswordChange: true });
  assert.equal(b.calls.length, 0);
  b.context.PortalSession.start({ role: '生徒' });
  b.context.PortalSession.start({ role: '生徒' });
  assert.equal(b.calls.length, 1);
  await b.events.get('focus')();
  assert.equal(b.calls.length, 1);
});
