const express=require('express'),multer=require('multer'),{randomUUID}=require('crypto');
const db=require('../config/database'),{auth,checkRole}=require('../middleware/auth'),obs=require('../services/obsMaster');
const router=express.Router();router.use(auth,checkRole('生徒','管理者','クルー','セールス'));
router.use((_q,r,n)=>{r.set('Cache-Control','no-store');n();});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:2,fields:3,fieldSize:24000,parts:5,fieldArrayIndexLimit:10}}).array('attachments',2);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const route=fn=>async(q,r)=>{try{await fn(q,r);}catch(e){if(!r.headersSent)r.status(e.status||500).json({error:e.status?e.message:'処理に失敗しました。時間をおいて再度お試しください。'});}};
const own=async(q)=>{
  if(!uuid(q.params.id)) throw fail(400,'会話IDが不正です');
  const row=(await db.query('SELECT * FROM tool_threads WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[q.params.id,q.user.id])).rows[0];
  if(!row) throw fail(404,'会話が見つかりません');return row;
};
router.get('/config',(_q,r)=>r.json({enabled:obs.config().enabled}));
router.get('/threads',route(async(q,r)=>r.json((await db.query('SELECT id,title,created_at FROM tool_threads WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',[q.user.id])).rows)));
router.post('/threads',route(async(q,r)=>{
  const id=randomUUID();
  const count=Number((await db.query('SELECT count(*) AS n FROM tool_threads WHERE user_id=$1 AND deleted_at IS NULL',[q.user.id])).rows[0].n);
  if(count>=100) throw fail(429,'会話は100件までです。不要な会話を削除してください');
  await db.query('INSERT INTO tool_threads(id,user_id,title) VALUES($1,$2,$3)',[id,q.user.id,'OBSの相談']);r.status(201).json({id});
}));
router.get('/threads/:id',route(async(q,r)=>{
  const thread=await own(q);
  const messages=(await db.query(`SELECT m.id,m.role,m.text,m.citations,m.created_at,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'kind',a.kind)) FROM tool_attachments a WHERE a.message_id=m.id),'[]') AS attachments
    FROM tool_messages m WHERE thread_id=$1 ORDER BY created_at,id`,[thread.id])).rows;
  r.json({thread,messages});
}));
router.delete('/threads/:id',route(async(q,r)=>{
  const t=await own(q),client=await db.pool.connect();
  try{await client.query('BEGIN');
    const row=(await client.query('SELECT busy_until FROM tool_threads WHERE id=$1 FOR UPDATE',[t.id])).rows[0];
    if(row.busy_until&&new Date(row.busy_until)>new Date()) throw fail(409,'回答中は削除できません');
    await client.query('UPDATE tool_threads SET deleted_at=CURRENT_TIMESTAMP,title=$2 WHERE id=$1',[t.id,'削除済み']);
    await client.query('DELETE FROM tool_messages WHERE thread_id=$1',[t.id]);
    await client.query('COMMIT');r.json({success:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
router.get('/attachments/:id',route(async(q,r)=>{
  if(!uuid(q.params.id)) throw fail(404,'添付が見つかりません');
  const a=(await db.query(`SELECT a.* FROM tool_attachments a JOIN tool_messages m ON m.id=a.message_id JOIN tool_threads t ON t.id=m.thread_id
    WHERE a.id=$1 AND t.user_id=$2 AND t.deleted_at IS NULL`,[q.params.id,q.user.id])).rows[0];
  if(!a) throw fail(404,'添付が見つかりません');r.set({'Content-Type':a.mime,'X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(a.name)}).send(Buffer.from(a.data));
}));
router.post('/threads/:id/messages',(q,r,n)=>{
  if(!obs.config().enabled) return r.status(503).json({error:'OBSマスターは準備中です。管理者へお問い合わせください。'});
  // Authenticate before parsing multipart and refuse parallel uploads per user in this process.
  if(active.has(q.user.id)||active.size>=4) return r.status(429).json({error:'回答処理が混み合っています。少しお待ちください。'});
  active.add(q.user.id);r.once('finish',()=>active.delete(q.user.id));r.once('close',()=>active.delete(q.user.id));
  upload(q,r,e=>e?r.status(400).json({error:'添付は2件、各2MBまで。文章は6000文字までです。'}):n());
},route(async(q,r)=>{
  const t=await own(q),text=typeof q.body.text==='string'?q.body.text.trim():'',requestId=q.body.requestId;
  if(!uuid(requestId)||text.length>6000||(!text&&!q.files?.length)) throw fail(400,'相談内容または添付を入力してください（6000文字以内）');
  let files;try{files=(q.files||[]).map(obs.attachment);}catch(e){throw fail(400,e.message);}
  const client=await db.pool.connect();let reserved=false;
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(8543412)');
    const row=(await client.query('SELECT * FROM tool_threads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[t.id])).rows[0];
    if(!row) throw fail(404,'会話が見つかりません');
    if(row.busy_until&&new Date(row.busy_until)>new Date()) throw fail(409,'回答中です');
    if((await client.query('SELECT id FROM tool_usage WHERE id=$1',[requestId])).rows.length) throw fail(409,'この送信は受け付け済みです。履歴を確認してください');
    const quota=(await client.query(`SELECT count(*) FILTER(WHERE user_id=$1 AND created_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo') AS daily,
      count(*) AS monthly FROM tool_usage WHERE created_at>=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`,[q.user.id])).rows[0];
    if(Number(quota.daily)>=30||Number(quota.monthly)>=10000) throw fail(429,'利用回数の上限に達しました（本人1日30回・全体月10000回）');
    const sizes=(await client.query(`SELECT (SELECT count(*) FROM tool_messages WHERE thread_id=$1) AS n,
      COALESCE((SELECT sum(octet_length(a.data)) FROM tool_attachments a JOIN tool_messages m ON m.id=a.message_id WHERE m.thread_id=$1),0) AS bytes`,[t.id])).rows[0];
    if(Number(sizes.n)>=40||Number(sizes.bytes)+files.reduce((n,a)=>n+a.data.length,0)>10*1024*1024) throw fail(400,'この会話の上限に達しました。新しい相談を作成してください');
    await client.query('INSERT INTO tool_usage(id,user_id,thread_id,model) VALUES($1,$2,$3,$4)',[requestId,q.user.id,t.id,obs.config().model]);
    const mid=randomUUID();await client.query("INSERT INTO tool_messages(id,thread_id,role,text) VALUES($1,$2,'user',$3)",[mid,t.id,text]);
    for(const a of files) await client.query('INSERT INTO tool_attachments(id,message_id,name,kind,mime,data) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),mid,a.name,a.kind,a.mime,a.data]);
    await client.query("UPDATE tool_threads SET busy_until=CURRENT_TIMESTAMP+INTERVAL '3 minutes',title=CASE WHEN title='OBSの相談' THEN $2 ELSE title END WHERE id=$1",[t.id,text.slice(0,60)||'添付についての相談']);
    await client.query('COMMIT');reserved=true;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  try{
    const messages=(await db.query('SELECT * FROM tool_messages WHERE thread_id=$1 ORDER BY created_at,id',[t.id])).rows;
    for(const m of messages) m.attachments=(await db.query('SELECT kind,mime,data FROM tool_attachments WHERE message_id=$1',[m.id])).rows.map(a=>({...a,data:Buffer.from(a.data)}));
    const result=await obs.answer(messages);
    // Persist billing metadata even if a response is incomplete. No automatic billable retry.
    await db.query(`UPDATE tool_usage SET status=$2,model=$3,input_tokens=$4,cached_tokens=$5,output_tokens=$6,searches=$7,estimated_usd=$8 WHERE id=$1`,
      [requestId,result.complete?'completed':'incomplete',result.model,result.usage.input_tokens,result.usage.input_tokens_details?.cached_tokens||0,result.usage.output_tokens,result.searches,result.usd]);
    if(!result.complete) throw fail(502,'回答が完了しませんでした。最新情報は確認済みとは限りません。履歴を確認してから相談を続けてください');
    await db.query("INSERT INTO tool_messages(id,thread_id,role,text,citations) VALUES($1,$2,'assistant',$3,$4)",[randomUUID(),t.id,result.text,JSON.stringify(result.citations)]);
    r.json({success:true});
  }catch(e){
    await db.query("UPDATE tool_usage SET status='unknown' WHERE id=$1 AND status='pending'",[requestId]);
    if(e.status) throw e;throw fail(502,'AIへの接続または回答の保存に失敗しました。課金が発生している可能性があります。自動再送はしていません。');
  }finally{if(reserved) await db.query('UPDATE tool_threads SET busy_until=NULL WHERE id=$1',[t.id]);}
}));
const active=new Set();
router.get('/usage',checkRole('管理者'),route(async(q,r)=>{
  const sql=`SELECT (created_at AT TIME ZONE 'Asia/Tokyo')::date AS day,model,status,count(*) AS requests,
    sum(input_tokens) AS input_tokens,sum(cached_tokens) AS cached_tokens,sum(output_tokens) AS output_tokens,sum(searches) AS searches,
    sum(estimated_usd) AS estimated_usd,count(*) FILTER(WHERE estimated_usd IS NULL) AS unpriced
    FROM tool_usage WHERE created_at>=CURRENT_TIMESTAMP-INTERVAL '62 days' GROUP BY day,model,status ORDER BY day DESC`;
  r.json({rows:(await db.query(sql)).rows,notice:'このアプリ経由の直近62日分。USD概算は設定単価による推計で、請求額ではありません。unknown/pendingは課金・使用量が不明です。税・為替・他アプリの利用は含みません。'});
}));
module.exports=router;
