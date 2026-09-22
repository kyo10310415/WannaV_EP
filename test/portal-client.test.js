const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('MP4進捗は表示中の再生だけactivityにし、再視聴も5%ごとに既存通信を使う', () => {
  const html = fs.readFileSync(path.join(__dirname, '../views/lesson.html'), 'utf8');
  const source = html.slice(html.indexOf('function initMp4Player()'), html.indexOf('// ===== 視聴バー更新'));
  const events = new Map();
  const calls = [];
  const video = { duration: 100, currentTime: 0, paused: false, seeking: false,
    addEventListener: (name, callback) => events.set(name, callback) };
  const context = {
    document: { visibilityState: 'visible', getElementById: id => id === 'video-player' ? video : { style: {} } },
    currentLesson: { completed: true, watch_percent: 100 },
    currentWatchPercent: 100, lastSavedPercent: 100,
    updateWatchBar() {}, saveWatchPercent: (...args) => calls.push(args)
  };
  vm.runInNewContext(source + '\ninitMp4Player();', context);
  video.currentTime = 5; events.get('timeupdate')();
  assert.deepEqual(calls.pop(), [5, true]);
  context.document.visibilityState = 'hidden';
  video.currentTime = 10; events.get('timeupdate')();
  assert.deepEqual(calls.pop(), [10, false]);
  context.document.visibilityState = 'visible'; video.paused = true;
  video.currentTime = 15; events.get('timeupdate')();
  assert.deepEqual(calls.pop(), [15, false]);
  video.paused = false; video.seeking = true;
  video.currentTime = 80; events.get('timeupdate')();
  assert.deepEqual(calls.pop(), [80, false]);
  video.seeking = false; events.get('seeked')(); events.get('timeupdate')();
  assert.equal(calls.length, 0);
  video.currentTime = 85; events.get('timeupdate')();
  assert.deepEqual(calls.pop(), [85, true]);
  context.document.visibilityState = 'hidden'; events.get('ended')();
  assert.deepEqual(calls.pop(), [100, false]);
});

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
