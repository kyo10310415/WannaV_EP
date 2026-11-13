const test = require('node:test');
const assert = require('node:assert/strict');

test('自己再設定：確認済メール限定・汎用応答・使い捨て・期限・競合・セッション失効・送信上限', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
 const { PGlite } = require(process.env.PGLITE_TEST_MODULE), pg = new PGlite();
 const db = require('../src/config/database'), old = { query: db.query, pool: db.pool }, env = { ...process.env };
 const mail = require('../src/services/recoveryEmailDelivery'), oldLink = mail.sendResetLink, oldNotice = mail.sendResetNotice;
 const reset = require('../src/models/PasswordReset'); let server, tail = Promise.resolve();
 async function lock() { const prev = tail; let release; tail = new Promise(r => { release = r; }); await prev; return release; }
 db.query = async (sql, args) => { const release = await lock(); try { return await pg.query(sql, args); } finally { release(); } };
 db.pool = { connect: async () => { const release = await lock(); return { query: (s, a) => pg.query(s, a), release }; } };
 Object.assign(process.env, { JWT_SECRET: 'isolated-self-reset', PAYMENT_ACCESS_CONTROL_ENABLED: 'false', RECOVERY_EMAIL_ENROLLMENT_ENABLED: 'false', RECOVERY_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'mock-only', RECOVERY_EMAIL_FROM: 'portal@example.com', PASSWORD_RESET_ENABLED: 'true', PASSWORD_RESET_ORIGIN: 'https://portal.example.com', RECOVERY_EMAIL_DAILY_LIMIT: '90' });
 const deliveries = [], notices = [];
 mail.sendResetLink = async (email, url, id, loginId) => { deliveries.push({ email, url, id, loginId }); };
 mail.sendResetNotice = async (...args) => { notices.push(args); };
 const originalRequest = reset.request, originalNotify = reset.notify, jobs = [];
 reset.request = (...args) => { const job = originalRequest(...args); jobs.push(job); return job; };
 reset.notify = (...args) => { const job = originalNotify(...args); jobs.push(job); return job; };
 async function flush() { await new Promise(setImmediate); await Promise.allSettled(jobs.splice(0)); }
 try {
  await require('../src/models/schema').createTables();
  const User = require('../src/models/User');
  const a = await User.create('dummy_student', 'original-password', 'ダミー生徒');
  const b = await User.create('other_student', 'original-password', '別の生徒');
  const c = await User.create('unverified_student', 'original-password', '未確認');
  const staff = await User.create('dummy_staff', 'original-password', 'ダミー管理者', '管理者');
  await db.query('UPDATE users SET password_changed_at=CURRENT_TIMESTAMP');
  for (const u of [a, b, c, staff]) await db.query('INSERT INTO user_recovery_emails(user_id,email,verified_at) VALUES($1,$2,$3)', [u.id, u.id === staff.id ? 'staff@example.com' : 'shared@example.com', u.id === c.id ? null : new Date()]);
  const express = require('express'), app = express(); app.use(express.json()); app.use('/api/auth/password-reset', require('../src/routes/passwordReset')); app.use('/api/auth', require('../src/routes/auth'));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  async function call(path, body, token, headers = {}) {
   const r = await fetch('http://127.0.0.1:' + server.address().port + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
   return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie') };
  }
  const request = (loginId = 'dummy_student', email = 'shared@example.com', headers) => call('/api/auth/password-reset/request', { loginId, email }, undefined, headers);
  const login = (email, password = 'original-password') => call('/api/auth/login', { email, password });
  const complete = (token, newPassword = 'replacement-password', confirmPassword = newPassword) => call('/api/auth/password-reset/complete', { token, newPassword, confirmPassword });
  const tokenOf = delivery => new URLSearchParams(new URL(delivery.url).hash.slice(1)).get('token');
  const oldToken = (await login('dummy_student')).data.token;
  const original = (await db.query('SELECT * FROM users WHERE id=$1', [a.id])).rows[0];
  let releaseMail, mailFinished = false;
  const pendingMail = new Promise(resolve => { releaseMail = resolve; });
  mail.sendResetLink = async (email, url, id, loginId) => { deliveries.push({ email, url, id, loginId }); await pendingMail; mailFinished = true; };
  const generic = await request(); assert.equal(generic.status, 202); assert.equal(mailFinished, false);
  releaseMail(); await flush(); assert.equal(deliveries.length, 1);
  mail.sendResetLink = async (email, url, id, loginId) => { deliveries.push({ email, url, id, loginId }); };
  assert.equal(deliveries[0].email, 'shared@example.com'); assert.equal(deliveries[0].loginId, 'dummy_student');
  assert.equal(new URL(deliveries[0].url).origin, 'https://portal.example.com'); assert.equal(new URL(deliveries[0].url).search, '');
  const token = tokenOf(deliveries[0]); assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const saved = (await db.query('SELECT * FROM password_reset_tokens WHERE user_id=$1', [a.id])).rows[0]; assert.notEqual(saved.token_hash, token); assert.equal(saved.token_hash.length, 64);
  for (const input of [['nonexistent', 'shared@example.com'], ['dummy_student', 'wrong@example.com'], ['unverified_student', 'shared@example.com']]) {
   assert.deepEqual((await request(...input)).data, generic.data); await flush();
  }
  assert.equal(deliveries.length, 1); assert.equal((await login('dummy_student')).status, 200);
  assert.equal((await request('dummy_student', 'bad\r\nBcc:bad@example.com')).status, 400);
  assert.equal((await complete(token, 'short')).status, 400); assert.equal((await complete(token, 'valid-password', 'different-password')).status, 400); assert.equal((await complete(token, 'あ'.repeat(25))).status, 400);
  assert.equal((await complete('x'.repeat(43))).status, 400);
  const done = await complete(token); await flush(); assert.equal(done.status, 200); assert.equal(done.data.token, undefined); assert.match(done.cookie, /portal_media=;/); assert.equal(notices.length, 1);
  assert.equal((await call('/api/auth/me', undefined, oldToken)).status, 401);
  assert.equal((await login('dummy_student')).status, 401); const refreshed = await login('dummy_student', 'replacement-password'); assert.equal(refreshed.status, 200); assert.equal(refreshed.data.user.role, '生徒'); assert.equal((await call('/api/auth/me', undefined, refreshed.data.token)).status, 200);
  assert.equal((await complete(token)).status, 400); assert.equal((await login('other_student')).status, 200);
  const after = (await db.query('SELECT * FROM users WHERE id=$1', [a.id])).rows[0]; for (const key of ['username', 'email', 'name', 'role']) assert.equal(after[key], original[key]);
  const ageDeliveries = () => db.query("UPDATE recovery_email_deliveries SET created_at=CURRENT_TIMESTAMP-INTERVAL '61 seconds'");
  await ageDeliveries(); await reset.request('other_student', 'shared@example.com'); const expiring = tokenOf(deliveries.at(-1)); await db.query("UPDATE password_reset_tokens SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE user_id=$1", [b.id]); assert.equal((await complete(expiring)).status, 400);
  await ageDeliveries(); await reset.request('other_student', 'shared@example.com'); const replaced = tokenOf(deliveries.at(-1)); await ageDeliveries(); await reset.request('other_student', 'shared@example.com'); const newest = tokenOf(deliveries.at(-1)); assert.notEqual(newest, replaced); assert.equal((await complete(replaced)).status, 400);
  const race = await Promise.all([complete(newest), complete(newest)]); await flush(); assert.deepEqual(race.map(r => r.status).sort(), [200, 400]);
  await ageDeliveries(); await reset.request('dummy_staff', 'staff@example.com'); const staffToken = tokenOf(deliveries.at(-1)); await User.resetStaffToInitialPassword(staff.id); assert.equal((await complete(staffToken)).status, 400);
  await ageDeliveries(); await reset.request('dummy_staff', 'staff@example.com'); const changed = tokenOf(deliveries.at(-1)); await User.resetPassword(staff.id, 'manually-changed-password'); assert.equal((await complete(changed)).status, 400);
  await ageDeliveries(); await reset.request('dummy_staff', 'staff@example.com'); const emailChanged = tokenOf(deliveries.at(-1)); await db.query("UPDATE user_recovery_emails SET email='different@example.com' WHERE user_id=$1", [staff.id]); assert.equal((await complete(emailChanged)).status, 400);
  await ageDeliveries(); const beforeFailedSend = deliveries.length; mail.sendResetLink = async () => { throw Error('private mail credentials'); }; await assert.rejects(reset.request('dummy_staff', 'different@example.com')); assert.equal(deliveries.length, beforeFailedSend); assert.equal((await db.query('SELECT token_hash FROM password_reset_tokens WHERE user_id=$1', [staff.id])).rows[0].token_hash, null);
  mail.sendResetLink = async (email, url, id, loginId) => deliveries.push({ email, url, id, loginId }); await ageDeliveries(); process.env.RECOVERY_EMAIL_DAILY_LIMIT = '1'; await reset.request('dummy_student', 'shared@example.com'); assert.equal(deliveries.length, beforeFailedSend);
  process.env.RECOVERY_EMAIL_DAILY_LIMIT = '90';
  for (const role of ['管理者', 'クルー', 'セールス']) {
   const u = await User.create('role_' + role, 'old-role-password', '権限テスト', role);
   await db.query("INSERT INTO user_recovery_emails(user_id,email,verified_at) VALUES($1,'role@example.com',CURRENT_TIMESTAMP)", [u.id]);
   await reset.request('role_' + role, 'role@example.com');
   assert.equal((await complete(tokenOf(deliveries.at(-1)))).status, 200); await flush();
   const signedIn = await login('role_' + role, 'replacement-password'); assert.equal(signedIn.status, 200); assert.equal(signedIn.data.user.role, role); assert.equal(signedIn.data.needsPasswordChange, false);
  }
  assert.equal(await reset.allow('test', 'identity', 2), true); assert.equal(await reset.allow('test', 'identity', 2), true); assert.equal(await reset.allow('test', 'identity', 2), false);
  const rateRows = (await db.query('SELECT key_hash FROM password_reset_rate_limits')).rows; assert.ok(rateRows.every(r => /^[a-f0-9]{64}$/.test(r.key_hash)));
  process.env.PASSWORD_RESET_ENABLED = 'false'; assert.equal((await request()).status, 503); assert.equal((await complete('x'.repeat(43))).status, 503);
 } finally {
  if (server) await new Promise(r => server.close(r)); await flush();
  reset.request = originalRequest; reset.notify = originalNotify; mail.sendResetLink = oldLink; mail.sendResetNotice = oldNotice; db.query = old.query; db.pool = old.pool; process.env = env; await pg.close();
 }
});

test('再設定URLは設定済みHTTPS origin限定でHostヘッダー由来の値は使わない', () => {
 const env = { ...process.env }; const reset = require('../src/models/PasswordReset');
 try {
  process.env.NODE_ENV = 'production';
  for (const value of ['', 'not a url', 'http://portal.example.com', 'https://user:pass@example.com', 'https://example.com/extra', 'https://example.com/?x=1', 'https://example.com/#fragment']) { process.env.PASSWORD_RESET_ORIGIN = value; assert.equal(reset.origin(), null); }
  process.env.PASSWORD_RESET_ORIGIN = 'https://portal.example.com'; assert.equal(reset.origin(), 'https://portal.example.com');
 } finally { process.env = env; }
});
