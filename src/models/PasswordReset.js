const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const mail = require('../services/recoveryEmailDelivery');
const digest = (purpose, value) => createHmac('sha256', process.env.JWT_SECRET).update(purpose + '\0' + value).digest('hex');
const invalidLink = () => Object.assign(Error('リンクが無効か、有効期限が切れています。再設定メールをもう一度お申し込みください。'), { status: 400 });

function origin() {
 try {
  const value = process.env.PASSWORD_RESET_ORIGIN;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
  return url.origin;
 } catch { return null; }
}
const enabled = () => process.env.PASSWORD_RESET_ENABLED === 'true' && !!origin() && mail.configured();

// Shared DB counters survive restarts; no raw IP addresses or submitted identities are stored.
async function allow(scope, value, maximum) {
 const key = digest('password-reset-rate', scope + '\0' + value);
 await db.query(`DELETE FROM password_reset_rate_limits WHERE key_hash IN (SELECT key_hash FROM password_reset_rate_limits WHERE window_start<CURRENT_TIMESTAMP-INTERVAL '1 hour' LIMIT 100)`);
 const result = await db.query(`INSERT INTO password_reset_rate_limits(key_hash) VALUES($1)
  ON CONFLICT(key_hash) DO UPDATE SET
   hits=CASE WHEN password_reset_rate_limits.window_start<CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN 1 ELSE password_reset_rate_limits.hits+1 END,
   window_start=CASE WHEN password_reset_rate_limits.window_start<CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN CURRENT_TIMESTAMP ELSE password_reset_rate_limits.window_start END
  RETURNING hits`, [key]);
 return result.rows[0].hits <= maximum;
}

async function reserveDelivery(client, userId) {
 const cap = Number(process.env.RECOVERY_EMAIL_DAILY_LIMIT || 90);
 if (!Number.isInteger(cap) || cap < 1) return null;
 const counts = (await client.query(`SELECT count(*) AS total,count(*) FILTER(WHERE user_id=$1) AS own FROM recovery_email_deliveries
  WHERE created_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`, [userId])).rows[0];
 if (Number(counts.total) >= cap || Number(counts.own) >= 5) return null;
 const id = randomUUID();
 await client.query('INSERT INTO recovery_email_deliveries(id,user_id) VALUES($1,$2)', [id, userId]);
 return id;
}

async function request(loginId, email) {
 if (!enabled()) return;
 const client = await db.pool.connect(); let delivery;
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(8543415)');
  const matches = (await client.query(`SELECT u.id,u.username,u.password,u.staff_password_reset_nonce,r.email
   FROM users u JOIN user_recovery_emails r ON r.user_id=u.id
   WHERE (LOWER(u.username)=LOWER($1) OR LOWER(u.email)=LOWER($1)) AND LOWER(r.email)=LOWER($2) AND r.verified_at IS NOT NULL
   LIMIT 2 FOR UPDATE OF u`, [loginId, email])).rows;
  if (matches.length === 1) {
   const user = matches[0];
   const recent = (await client.query(`SELECT 1 FROM recovery_email_deliveries WHERE user_id=$1 AND created_at>CURRENT_TIMESTAMP-INTERVAL '60 seconds' LIMIT 1`, [user.id])).rows.length;
   if (!recent) {
    const id = await reserveDelivery(client, user.id);
    if (id) {
     const token = randomBytes(32).toString('base64url'), hash = digest('password-reset-token', token);
     await client.query(`INSERT INTO password_reset_tokens(user_id,token_hash,session_nonce,password_version,email,expires_at)
      VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP+INTERVAL '15 minutes') ON CONFLICT(user_id) DO UPDATE SET
      token_hash=EXCLUDED.token_hash,session_nonce=EXCLUDED.session_nonce,password_version=EXCLUDED.password_version,email=EXCLUDED.email,expires_at=EXCLUDED.expires_at,created_at=CURRENT_TIMESTAMP`,
     [user.id, hash, user.staff_password_reset_nonce || null, digest('password-reset-version', user.password), user.email]);
     delivery = { id, userId: user.id, email: user.email, loginId: user.username || loginId, hash, url: origin() + '/reset-password#token=' + token };
    }
   }
  }
  await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
 if (delivery) {
  try { await mail.sendResetLink(delivery.email, delivery.url, delivery.id, delivery.loginId); }
  catch {
   await db.query('UPDATE password_reset_tokens SET token_hash=NULL WHERE user_id=$1 AND token_hash=$2', [delivery.userId, delivery.hash]);
   throw Error('PASSWORD_RESET_DELIVERY_FAILED');
  }
 }
}

async function complete(token, password) {
 if (!enabled()) throw Object.assign(Error('現在パスワードの再設定は利用できません。担当者へお問い合わせください。'), { status: 503 });
 const hash = digest('password-reset-token', token);
 // Only spend bcrypt work for a plausible, unexpired token; recheck under locks afterwards.
 const candidate = (await db.query('SELECT user_id FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP', [hash])).rows[0];
 if (!candidate) throw invalidLink();
 const hashed = await bcrypt.hash(password, 10), client = await db.pool.connect(); let account;
 try {
  await client.query('BEGIN');
  const user = (await client.query('SELECT id,password,staff_password_reset_nonce FROM users WHERE id=$1 FOR UPDATE', [candidate.user_id])).rows[0];
  const reset = (await client.query('SELECT * FROM password_reset_tokens WHERE user_id=$1 FOR UPDATE', [candidate.user_id])).rows[0];
  const email = (await client.query('SELECT email,verified_at FROM user_recovery_emails WHERE user_id=$1 FOR UPDATE', [candidate.user_id])).rows[0];
  if (!user || !reset || reset.token_hash !== hash || new Date(reset.expires_at).getTime() <= Date.now() ||
   (reset.session_nonce || null) !== (user.staff_password_reset_nonce || null) || reset.password_version !== digest('password-reset-version', user.password) ||
   !email?.verified_at || email.email.toLowerCase() !== reset.email.toLowerCase()) throw invalidLink();
  await client.query('UPDATE users SET password=$1,password_changed_at=CURRENT_TIMESTAMP,staff_password_reset_nonce=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3', [hashed, randomUUID(), user.id]);
  await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [user.id]);
  await client.query('UPDATE user_recovery_emails SET code_hash=NULL,challenge_nonce=NULL,expires_at=NULL WHERE user_id=$1', [user.id]);
  await client.query('COMMIT'); account = { userId: user.id, email: email.email };
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
 return account;
}

// Best-effort security notice; mail failures must never roll back a successful reset.
async function notify(account) {
 const client = await db.pool.connect(); let id;
 try {
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(8543415)');
  id = await reserveDelivery(client, account.userId); await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
 if (id) await mail.sendResetNotice(account.email, id);
}
module.exports = { enabled, origin, allow, request, complete, notify };
