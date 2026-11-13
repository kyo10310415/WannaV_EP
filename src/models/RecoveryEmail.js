const {randomUUID,randomInt,createHmac,timingSafeEqual}=require('node:crypto');
const db=require('../config/database');
const mail=require('../services/recoveryEmailDelivery');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const enabled=()=>process.env.RECOVERY_EMAIL_ENROLLMENT_ENABLED==='true';
function digest(userId,nonce,email,code){return createHmac('sha256',process.env.JWT_SECRET).update(JSON.stringify(['recovery-email-v1',userId,nonce,email,code])).digest('hex');}
async function status(userId){const row=(await db.query('SELECT email,verified_at,sent_at FROM user_recovery_emails WHERE user_id=$1',[userId])).rows[0];return {enabled:enabled(),verified:!!row?.verified_at,email:row?.email||null};}
async function required(userId){return enabled()&&!(await status(userId)).verified;}
async function lockUser(client,userId,nonce){const user=(await client.query('SELECT staff_password_reset_nonce,password_changed_at FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];if(!user||!user.password_changed_at||(user.staff_password_reset_nonce||null)!==(nonce||null))throw fail(401,'ログイン状態が変わりました。再度ログインしてください。');}
async function request(userId,email,nonce){
 if(!enabled()||!mail.configured())throw fail(503,'メール登録の準備中です。管理者へお問い合わせください。');
 const cap=Number(process.env.RECOVERY_EMAIL_DAILY_LIMIT||90);if(!Number.isInteger(cap)||cap<1)throw fail(503,'メール送信設定を確認してください。');
 const id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0'),client=await db.pool.connect();
 try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(8543415)');await lockUser(client,userId,nonce);
  const row=(await client.query('SELECT verified_at,sent_at FROM user_recovery_emails WHERE user_id=$1',[userId])).rows[0];if(row?.verified_at)throw fail(409,'メールアドレスは登録済みです。');
  if(row?.sent_at&&Date.now()-new Date(row.sent_at).getTime()<60000)throw fail(429,'再送は60秒ほど待ってからお試しください。');
  const counts=(await client.query("SELECT count(*) AS total,count(*) FILTER(WHERE user_id=$1) AS own FROM recovery_email_deliveries WHERE created_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'",[userId])).rows[0];
  if(Number(counts.own)>=5)throw fail(429,'本日の確認メールの送信上限に達しました。明日以降にお試しください。');if(Number(counts.total)>=cap)throw fail(429,'本日のメール送信が混み合っています。管理者へお問い合わせください。');
  await client.query(`INSERT INTO user_recovery_emails(user_id,email,code_hash,challenge_nonce,session_nonce,expires_at,attempts,sent_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP+INTERVAL '10 minutes',0,CURRENT_TIMESTAMP)
   ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,code_hash=EXCLUDED.code_hash,challenge_nonce=EXCLUDED.challenge_nonce,session_nonce=EXCLUDED.session_nonce,expires_at=EXCLUDED.expires_at,attempts=0,sent_at=CURRENT_TIMESTAMP`,[userId,email,digest(userId,id,email,code),id,nonce||null]);
  await client.query('INSERT INTO recovery_email_deliveries(id,user_id) VALUES($1,$2)',[id,userId]);await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 try{await mail.send(email,code,id);}catch(_){await db.query('UPDATE user_recovery_emails SET code_hash=NULL,challenge_nonce=NULL,expires_at=NULL WHERE user_id=$1 AND challenge_nonce=$2 AND verified_at IS NULL',[userId,id]);throw fail(503,'確認メールを送信できませんでした。時間をおいて再送してください。');}
 return {sent:true,email};
}
async function verify(userId,code,nonce){
 if(!enabled())throw fail(503,'メール登録は現在有効になっていません。');const client=await db.pool.connect();let valid=false;
 try{await client.query('BEGIN');await lockUser(client,userId,nonce);const row=(await client.query('SELECT * FROM user_recovery_emails WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
  if(row?.verified_at){await client.query('COMMIT');return {verified:true,alreadyVerified:true};}
  if(row?.code_hash&&row?.challenge_nonce&&new Date(row.expires_at).getTime()>Date.now()&&row.attempts<5&&(row.session_nonce||null)===(nonce||null)){
   valid=timingSafeEqual(Buffer.from(digest(userId,row.challenge_nonce,row.email,code),'hex'),Buffer.from(row.code_hash,'hex'));
   if(valid)await client.query('UPDATE user_recovery_emails SET verified_at=CURRENT_TIMESTAMP,code_hash=NULL,challenge_nonce=NULL,expires_at=NULL,attempts=0 WHERE user_id=$1',[userId]);
   else await client.query('UPDATE user_recovery_emails SET attempts=attempts+1 WHERE user_id=$1',[userId]);
  }await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 if(!valid)throw fail(400,'確認コードが違うか、有効期限が切れています。必要に応じて再送してください。');return {verified:true};
}
module.exports={enabled,status,required,request,verify};
