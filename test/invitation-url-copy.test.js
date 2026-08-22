const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'admin-student-management.html'),
  'utf8'
);

test('生徒管理ページに招待URLコピーボタンを表示する', () => {
  assert.match(page, /onclick="copyInvitationUrl\(\)"/);
  assert.match(page, /招待URLをコピー/);
});

test('現在のアプリルートURLをClipboard APIでコピーする', () => {
  assert.match(page, /new URL\('\/', window\.location\.origin\)\.href/);
  assert.match(page, /navigator\.clipboard\.writeText\(invitationUrl\)/);
});

test('Clipboard APIが利用できない環境でもコピーできるフォールバックを持つ', () => {
  assert.match(page, /function copyTextFallback\(text\)/);
  assert.match(page, /document\.execCommand\('copy'\)/);
  assert.match(page, /招待URLをコピーできませんでした/);
});
