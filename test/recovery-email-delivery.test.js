const test = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../src/services/recoveryEmailDelivery');

function setup() {
 const env = { ...process.env };
 Object.assign(process.env, {
  RECOVERY_EMAIL_PROVIDER: 'google_workspace',
  GOOGLE_WORKSPACE_SMTP_USER: 'portal@example.com',
  GOOGLE_WORKSPACE_APP_PASSWORD: 'abcd efgh ijkl mnop',
  RECOVERY_EMAIL_FROM: 'portal@example.com',
  RESEND_API_KEY: 'unused-mock'
 });
 return () => { process.env = env; };
}

test('Workspace設定は明示選択・本人送信元・アプリパスワードを必要とし、不備で他社へ切り替えない', async () => {
 const restore = setup();
 try {
  assert.equal(mail.configured(), true);
  for (const [key, value] of [
   ['RECOVERY_EMAIL_PROVIDER', 'unknown'],
   ['GOOGLE_WORKSPACE_APP_PASSWORD', ''],
   ['GOOGLE_WORKSPACE_APP_PASSWORD', 'not-an-app-password'],
   ['GOOGLE_WORKSPACE_SMTP_USER', 'other@example.com'],
   ['RECOVERY_EMAIL_FROM', 'portal@example.com\r\nBcc:bad@example.com']
  ]) {
   const original = process.env[key]; process.env[key] = value;
   assert.equal(mail.configured(), false);
   await assert.rejects(mail.send('dummy@example.com', '012345', 'test', () => { throw Error('must not fetch'); }, () => { throw Error('must not connect'); }), /RECOVERY_MAIL_NOT_CONFIGURED/);
   process.env[key] = original;
  }
 } finally { restore(); }
});

test('Workspace送信はGoogle固定・TLS検証・タイムアウト・ログ無効・平文コードのみ・送信後切断', async () => {
 const restore = setup(); let options, message, closed = 0;
 try {
  await mail.send('dummy@example.com', '012345', 'test-id', () => { throw Error('must not fetch'); }, settings => {
   options = settings;
   return { sendMail: async data => { message = data; return { accepted: ['dummy@example.com'] }; }, close: () => { closed++; } };
  });
  assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465); assert.equal(options.secure, true);
  assert.equal(options.auth.user, 'portal@example.com'); assert.equal(options.auth.pass, 'abcdefghijklmnop');
  assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.minVersion, 'TLSv1.2');
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.ok(options[key] > 0 && options[key] <= 15000);
  assert.equal(options.logger, false); assert.equal(options.debug, false);
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
  assert.equal(message.from.address, 'portal@example.com'); assert.deepEqual(message.to, ['dummy@example.com']);
  assert.match(message.text, /012345/); assert.equal(message.html, undefined); assert.equal(message.attachments, undefined);
  assert.match(message.messageId, /^<recovery-[a-f0-9]{64}@example.com>$/); assert.equal(closed, 1);
 } finally { restore(); }
});

test('Workspaceの認証失敗・タイムアウト・宛先拒否は詳細を公開せず再送せず切断する', async () => {
 const restore = setup();
 try {
  for (const failure of ['auth', 'timeout', 'rejected']) {
   let sent = 0, closed = 0;
   await assert.rejects(mail.send('dummy@example.com', '012345', 'test', undefined, () => ({
    sendMail: async () => { sent++; if (failure !== 'rejected') throw Error('sensitive provider details'); return { accepted: [], rejected: ['dummy@example.com'] }; },
    close: () => { closed++; }
   })), error => error.message === 'RECOVERY_MAIL_DELIVERY_FAILED');
   assert.equal(sent, 1); assert.equal(closed, 1);
  }
 } finally { restore(); }
});

test('実際のNodemailerで日本語本文と件名をMIME化できる（ネットワーク通信なし）', async () => {
 const restore = setup(); let raw;
 try {
  await mail.send('dummy@example.com', '012345', 'test', undefined, () => {
   const stream = require('nodemailer').createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
   return { sendMail: async message => { const result = await stream.sendMail(message); raw = result.message.toString(); return { accepted: message.to }; }, close: () => stream.close() };
  });
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/i);
  assert.match(raw, /From: =\?UTF-8\?/i); assert.match(raw, /Subject: =\?UTF-8\?/i);
  assert.match(raw, /To: dummy@example.com/); assert.doesNotMatch(raw, /abcdefghijklmnop/);
 } finally { restore(); }
});
