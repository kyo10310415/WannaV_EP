const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('閉じるだけなら次回も表示し、当日非表示を選んだ場合だけ保存する', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../views/dashboard.html'), 'utf8');
  const source = html.slice(html.indexOf('async function loadImportantMessage()'), html.indexOf('async function checkAuth()'));
  const calls = [];
  const elements = {
    'important-message-body': { textContent: '' },
    'important-message-link': { hidden: true, href: '' },
    'important-message-today': { checked: false },
    'important-message-error': { textContent: '' },
    'important-message-close': { disabled: false },
    'important-message-dialog': {
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; }
    }
  };
  let message = { body: 'メンテナンス予定', url: 'https://example.test/info', revision: 2 };
  const context = {
    API_URL: '/api', currentImportantMessage: null,
    document: { getElementById: id => elements[id] },
    localStorage: { getItem: () => 'token' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/dismiss') ? { success: true } : { message } };
    },
    console,
  };
  vm.runInNewContext(source + '\nthis.load = loadImportantMessage; this.close = closeImportantMessage;', context);
  await context.load();
  assert.equal(elements['important-message-dialog'].open, true);
  assert.equal(elements['important-message-body'].textContent, 'メンテナンス予定');
  assert.equal(elements['important-message-link'].href, 'https://example.test/info');
  await context.close();
  assert.equal(calls.filter(call => call.url.endsWith('/dismiss')).length, 0);
  await context.load();
  assert.equal(elements['important-message-dialog'].open, true);
  elements['important-message-today'].checked = true;
  await context.close();
  assert.equal(elements['important-message-dialog'].open, false);
  assert.equal(calls.filter(call => call.url.endsWith('/dismiss')).length, 1);
  assert.equal(JSON.parse(calls.at(-1).options.body).revision, 2);
  message = { body: 'URLなし', url: null, revision: 3 };
  await context.load();
  assert.equal(elements['important-message-link'].hidden, true);
  await context.close();
  message = null;
  await context.load();
  assert.equal(elements['important-message-dialog'].open, false);
});
