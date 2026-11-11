const express=require('express'),multer=require('multer'),{randomUUID}=require('crypto');
const db=require('../config/database'),{auth,checkRole}=require('../middleware/auth'),obs=require('../services/obsMaster'),pricing=require('../services/toolPricing'),exchange=require('../services/toolExchangeRate'),budget=require('../services/toolBudget');
const active=new Set();
function createToolRouter(toolKey='obs-master') {
const definitions={
  'obs-master':{service:obs,title:'OBSマスター',defaultTitle:'OBSの相談'},
  'vtube-studio':{service:require('../services/vtubeStudioMaster'),title:'VTube Studioマスター',defaultTitle:'VTube Studioの相談'},
  'streaming-gear':{service:require('../services/streamingGearConcierge'),title:'配信機材コンシェルジュ',defaultTitle:'配信機材の相談'},
  'kanau':{service:require('../services/kanau'),title:'かなうさん',defaultTitle:'イラスト制作の相談'},
  'youtube-analyst':{service:require('../services/youtubeAnalyst'),title:'YouTubeアナリティクス分析官',defaultTitle:'YouTube分析の相談'},
  'youtube-game-strategy':{service:require('../services/youtubeGameStrategy'),title:'YouTubeゲーム配信 戦略分析官',defaultTitle:'ゲーム配信戦略の相談'}
};
if(!Object.hasOwn(definitions,toolKey)) throw new Error('Unknown tool');
const {service,title,defaultTitle}=definitions[toolKey];
const isKanau=toolKey==='kanau';
const isYoutube=toolKey==='youtube-analyst',isGame=toolKey==='youtube-game-strategy',fileLimit=isYoutube||isGame?3:2;
const router=express.Router();router.use(auth,checkRole('生徒','管理者','クルー','セールス'));
router.use((_q,r,n)=>{r.set('Cache-Control','no-store');n();});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:fileLimit,fields:isYoutube?4:3,fieldSize:24000,parts:isYoutube||isGame?7:5,fieldArrayIndexLimit:10}}).array('attachments',fileLimit);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const route=fn=>async(q,r)=>{try{await fn(q,r);}catch(e){if(!r.headersSent)r.status(e.status||500).json({error:e.status?e.message:'処理に失敗しました。時間をおいて再度お試しください。'});}finally{q.releaseToolSlot?.();}};
const own=async(q)=>{
  if(!uuid(q.params.id)) throw fail(400,'会話IDが不正です');
  const row=(await db.query('SELECT * FROM tool_threads WHERE id=$1 AND user_id=$2 AND tool_key=$3 AND deleted_at IS NULL',[q.params.id,q.user.id,toolKey])).rows[0];
  if(!row) throw fail(404,'会話が見つかりません');return row;
};
router.get('/config',route(async(_q,r)=>{
  let state;try{state=await budget.summary();}catch(_){state={blocked:true,reason:'現在使用できません。時間をおいて再度お試しください。'};}
  r.json({enabled:service.config().enabled&&!state.blocked,...(state.blocked?{unavailableMessage:state.reason,retryAfterSeconds:state.pending>0?15:state.reason===budget.UNAVAILABLE&&state.day?Math.max(5,Math.ceil((Date.parse(state.day+'T00:00:00+09:00')+86400000-Date.now())/1000)):30}:{}),...(isYoutube?{imageEnabled:service.config().imageEnabled}:{}),...(isGame?{initialMessage:service.initialMessage}:{})});
}));
router.get('/threads',route(async(q,r)=>r.json((await db.query('SELECT id,title,created_at FROM tool_threads WHERE user_id=$1 AND tool_key=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',[q.user.id,toolKey])).rows)));
router.post('/threads',route(async(q,r)=>{
  const id=randomUUID();
  const count=Number((await db.query('SELECT count(*) AS n FROM tool_threads WHERE user_id=$1 AND deleted_at IS NULL',[q.user.id])).rows[0].n);
  if(count>=100) throw fail(429,'会話は100件までです。不要な会話を削除してください');
  if(isGame)await db.query("WITH t AS (INSERT INTO tool_threads(id,user_id,title,tool_key) VALUES($1,$2,$3,$4) RETURNING id) INSERT INTO tool_messages(id,thread_id,role,text) SELECT $5,id,'assistant',$6 FROM t",[id,q.user.id,defaultTitle,toolKey,randomUUID(),service.initialMessage]);
  else await db.query('INSERT INTO tool_threads(id,user_id,title,tool_key) VALUES($1,$2,$3,$4)',[id,q.user.id,defaultTitle,toolKey]);r.status(201).json({id});
}));
router.get('/threads/:id',route(async(q,r)=>{
  const thread=await own(q);
  const messages=(await db.query(`SELECT m.id,m.role,m.text,m.citations,m.metadata,m.created_at,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'kind',a.kind)) FROM tool_attachments a WHERE a.message_id=m.id),'[]') AS attachments
    FROM tool_messages m WHERE thread_id=$1 ORDER BY created_at,id`,[thread.id])).rows;
  const {game_session,...visibleThread}=thread;r.json({thread:visibleThread,messages});
}));
router.delete('/threads/:id',route(async(q,r)=>{
  const t=await own(q),client=await db.pool.connect();
  try{await client.query('BEGIN');
    const row=(await client.query('SELECT busy_until FROM tool_threads WHERE id=$1 FOR UPDATE',[t.id])).rows[0];
    if(row.busy_until&&new Date(row.busy_until)>new Date()) throw fail(409,'回答中は削除できません');
    await client.query('UPDATE tool_threads SET deleted_at=CURRENT_TIMESTAMP,title=$2,game_session=NULL WHERE id=$1',[t.id,'削除済み']);
    await client.query('DELETE FROM tool_messages WHERE thread_id=$1',[t.id]);
    await client.query('COMMIT');if(isGame)await service.cleanupSession(t.game_session).catch(()=>console.warn('Game strategy session cleanup incomplete'));r.json({success:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
router.get('/attachments/:id',route(async(q,r)=>{
  if(!uuid(q.params.id)) throw fail(404,'添付が見つかりません');
  const a=(await db.query(`SELECT a.* FROM tool_attachments a JOIN tool_messages m ON m.id=a.message_id JOIN tool_threads t ON t.id=m.thread_id
    WHERE a.id=$1 AND t.user_id=$2 AND t.tool_key=$3 AND t.deleted_at IS NULL`,[q.params.id,q.user.id,toolKey])).rows[0];
  if(!a) throw fail(404,'添付が見つかりません');r.set({'Content-Type':a.mime,'X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(a.name)}).send(Buffer.from(a.data));
}));
router.post('/threads/:id/messages',(q,r,n)=>{
  if(!service.config().enabled) return r.status(503).json({error:title+'は準備中です。管理者へお問い合わせください。'});
  // Authenticate before parsing multipart and refuse parallel uploads per user in this process.
  if(active.has(q.user.id)||active.size>=4) return r.status(429).json({error:'回答処理が混み合っています。少しお待ちください。'});
  active.add(q.user.id);
  let processing=false,closed=false,released=false;
  const release=()=>{if(!released){released=true;active.delete(q.user.id);}};q.releaseToolSlot=release;
  // A disconnected client does not cancel provider work. Hold the slot until it settles.
  r.once('close',()=>{closed=true;if(!processing)release();});
  upload(q,r,e=>{
    if(closed){release();return;}
    if(e){release();return r.status(400).json({error:`添付は${fileLimit}件、各2MBまで。文章は6000文字までです。`});}
    processing=true;n();
  });
},route(async(q,r)=>{
  const t=await own(q),text=typeof q.body.text==='string'?q.body.text.trim():'',requestId=q.body.requestId;
  if(!uuid(requestId)||text.length>6000||(!text&&!q.files?.length)) throw fail(400,'相談内容または添付を入力してください（6000文字以内）');
  let files;try{files=(q.files||[]).map(isYoutube||isGame?service.attachment:obs.attachment);}catch(e){throw fail(400,e.message);}
  const metadata=isKanau?{size:q.body.size||'1536x864'}:isYoutube?{mode:q.body.mode||'analyze',size:'1536x864'}:{};
  if(isYoutube&&!['analyze','thumbnail'].includes(metadata.mode))throw fail(400,'分析または改善サムネイル作成を選んでください');
  const imageMode=isKanau||(isYoutube&&metadata.mode==='thumbnail');
  if(isYoutube&&imageMode&&!service.config().imageEnabled)throw fail(503,'画像生成は準備中です。分析モードは利用できます');
  if(isYoutube&&imageMode&&!text)throw fail(400,'動画タイトル・内容・希望する改善を入力してください');
  if(isKanau&&(!text||!service.SIZES.includes(metadata.size)||files.some(a=>a.kind!=='image')))throw fail(400,'希望デザインと画像を指定してください。サイズは横長・正方形・縦長から選べます');
  const rateInfo=await exchange.dailyRate();
  const client=await db.pool.connect();let reserved=false;
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(8543412)');
    const row=(await client.query('SELECT * FROM tool_threads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[t.id])).rows[0];
    if(!row) throw fail(404,'会話が見つかりません');
    if(row.busy_until&&new Date(row.busy_until)>new Date()) throw fail(409,'回答中です');
    if((await client.query('SELECT id FROM tool_usage WHERE id=$1',[requestId])).rows.length) throw fail(409,'この送信は受け付け済みです。履歴を確認してください');
    const hold=await budget.reserve(client,rateInfo,toolKey,imageMode);
    const quota=(await client.query(`SELECT count(*) FILTER(WHERE user_id=$1 AND created_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo') AS daily,
      count(*) AS monthly,to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS day FROM tool_usage WHERE created_at>=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`,[q.user.id])).rows[0];
    if(quota.day&&quota.day!==rateInfo.day)throw fail(503,'日付が変わりました。もう一度送信してください。');
    if(Number(quota.daily)>=30||Number(quota.monthly)>=10000) throw fail(429,'利用回数の上限に達しました（本人1日30回・全体月10000回）');
    if(imageMode){
      const count=Number((await client.query("SELECT count(*) AS n FROM tool_usage WHERE user_id=$1 AND (tool_key='kanau' OR (tool_key='youtube-analyst' AND image_model IS NOT NULL)) AND created_at>=date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'",[q.user.id])).rows[0].n);
      if(count>=3)throw fail(429,'画像生成は本人1日3回までです（失敗・結果不明の送信も含みます）');
      const refs=Number((await client.query("SELECT count(*) AS n FROM tool_attachments a JOIN tool_messages m ON m.id=a.message_id WHERE m.thread_id=$1 AND m.role='user' AND a.kind='image'",[t.id])).rows[0].n);
      if(!refs&&!files.some(a=>a.kind==='image'))throw fail(400,isYoutube?'元のサムネイルまたは立ち絵の画像を添付してください':'最初に立ち絵の画像を添付してください');
    }
    const sizes=(await client.query(`SELECT (SELECT count(*) FROM tool_messages WHERE thread_id=$1) AS n,
      COALESCE((SELECT sum(octet_length(a.data)) FROM tool_attachments a JOIN tool_messages m ON m.id=a.message_id WHERE m.thread_id=$1),0) AS bytes`,[t.id])).rows[0];
    if(Number(sizes.n)>=40||Number(sizes.bytes)+files.reduce((n,a)=>n+a.data.length,0)+(imageMode?service.MAX_OUTPUT_BYTES:0)>10*1024*1024) throw fail(400,'この会話の上限に達しました。新しい相談を作成してください');
    await client.query('INSERT INTO tool_usage(id,user_id,thread_id,model,tool_key,image_model,fx_day,fx_rate,budget_hold_jpy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[requestId,q.user.id,t.id,service.config().model,toolKey,imageMode?service.config().imageModel:null,rateInfo.day,rateInfo.rate,hold]);
    const mid=randomUUID();await client.query("INSERT INTO tool_messages(id,thread_id,role,text,metadata) VALUES($1,$2,'user',$3,$4)",[mid,t.id,text,JSON.stringify(metadata)]);
    for(const a of files) await client.query('INSERT INTO tool_attachments(id,message_id,name,kind,mime,data) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),mid,a.name,a.kind,a.mime,a.data]);
    await client.query("UPDATE tool_threads SET busy_until=CURRENT_TIMESTAMP+$4::interval,title=CASE WHEN title=$3 THEN $2 ELSE title END WHERE id=$1",[t.id,text.slice(0,60)||'添付についての相談',defaultTitle,isGame?'10 minutes':imageMode?'6 minutes':'3 minutes']);
    await client.query('COMMIT');reserved=true;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  try{
    const messages=(await db.query('SELECT * FROM tool_messages WHERE thread_id=$1 ORDER BY created_at,id',[t.id])).rows;
    for(const m of messages) m.attachments=(await db.query('SELECT kind,mime,data FROM tool_attachments WHERE message_id=$1',[m.id])).rows.map(a=>({...a,data:Buffer.from(a.data)}));
    const gameState=isGame?(await db.query("SELECT game_session FROM tool_threads WHERE id=$1 AND user_id=$2 AND tool_key='youtube-game-strategy' AND deleted_at IS NULL",[t.id,q.user.id])).rows[0]?.game_session:null;
    const gameOptions=isGame?{session:gameState,saveSession:async session=>{
      const saved=await db.query("UPDATE tool_threads SET game_session=$3 WHERE id=$1 AND user_id=$2 AND tool_key='youtube-game-strategy' AND deleted_at IS NULL RETURNING id",[t.id,q.user.id,JSON.stringify(session)]);
      if(!saved.rows.length)throw new Error('SESSION_SAVE_FAILED');
    }}:undefined;
    const result=isGame?await service.answer(messages,fetch,gameOptions):await service.answer(messages);
    // Persist billing metadata even if a response is incomplete. No automatic billable retry.
    await db.query(`UPDATE tool_usage SET status=$2,model=$3,input_tokens=$4,cached_tokens=$5,output_tokens=$6,searches=$7,estimated_usd=$8,cost_details=$9,estimated_jpy=$10 WHERE id=$1`,
      [requestId,result.complete?'completed':'incomplete',result.model,result.usageKnown===false?null:result.usage.input_tokens,result.usageKnown===false?null:result.usage.input_tokens_details?.cached_tokens||0,result.usageKnown===false?null:result.usage.output_tokens,result.searches,result.usd,JSON.stringify(result.costDetails||null),pricing.jpy(result.usd,rateInfo.rate)]);
    if(imageMode)await db.query('UPDATE tool_usage SET image_calls=$2,image_model=$3,usage_known=$4 WHERE id=$1',[requestId,result.imageCalls,result.imageModel,result.usageKnown]);
    if(isGame&&!result.complete&&result.diagnostic){const d=result.diagnostic;throw fail(502,`分析を完了できませんでした。処理：${d.stage}／コード：${d.code}／HTTP：${d.httpStatus||'—'}／API：${d.providerCode||'—'}。課金が発生している可能性があります。自動再送はしていません。`);}
    if(!result.complete) throw fail(502,isGame?'CSV計算または公開情報の調査・分析が完了しませんでした。課金が発生している可能性があります。自動再送せず停止しました。履歴を確認してください。':imageMode?'画像生成が完了しませんでした。課金が発生している可能性があります。自動再送はしていません。':'回答が完了しませんでした。最新情報は確認済みとは限りません。履歴を確認してから相談を続けてください');
    if(imageMode){const save=await db.pool.connect();try{
      await save.query('BEGIN');const mid=randomUUID();
      await save.query("INSERT INTO tool_messages(id,thread_id,role,text,citations) VALUES($1,$2,'assistant',$3,$4)",[mid,t.id,result.text,'[]']);
      for(const image of result.images)await save.query('INSERT INTO tool_attachments(id,message_id,name,kind,mime,data) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),mid,image.name,image.kind,image.mime,image.data]);
      await save.query('COMMIT');
    }catch(e){await save.query('ROLLBACK');throw e;}finally{save.release();}}
    else await db.query("INSERT INTO tool_messages(id,thread_id,role,text,citations) VALUES($1,$2,'assistant',$3,$4)",[randomUUID(),t.id,result.text,JSON.stringify(result.citations)]);
    r.json({success:true});
  }catch(e){
    await db.query("UPDATE tool_usage SET status='unknown' WHERE id=$1 AND status='pending'",[requestId]);
    if(e.status) throw e;throw fail(502,'AIへの接続または回答の保存に失敗しました。課金が発生している可能性があります。自動再送はしていません。');
  }finally{if(reserved) await db.query('UPDATE tool_threads SET busy_until=NULL WHERE id=$1',[t.id]);}
}));
router.get('/usage',checkRole('管理者'),route(async(q,r)=>{
  const sql=`SELECT (created_at AT TIME ZONE 'Asia/Tokyo')::date AS day,tool_key,model,status,count(*) AS requests,
    sum(input_tokens) AS input_tokens,sum(cached_tokens) AS cached_tokens,sum(output_tokens) AS output_tokens,sum(searches) AS searches,sum(image_calls) AS image_calls,image_model,
    sum(COALESCE(estimated_jpy,estimated_usd*COALESCE(fx_rate,(SELECT rate FROM tool_exchange_rates e WHERE e.day=(tool_usage.created_at AT TIME ZONE 'Asia/Tokyo')::date),$1))) AS estimated_jpy,
    sum(COALESCE((cost_details->>'known_usd')::numeric,estimated_usd)*COALESCE(fx_rate,(SELECT rate FROM tool_exchange_rates e WHERE e.day=(tool_usage.created_at AT TIME ZONE 'Asia/Tokyo')::date),$1)) AS known_jpy,
    sum((cost_details->>'reused_container')::boolean::int) AS reused_containers,sum((cost_details->>'reused_audit')::boolean::int) AS reused_audits,sum((cost_details->>'reused_research')::boolean::int) AS reused_researches,
    sum(estimated_usd) AS estimated_usd,sum(COALESCE((cost_details->>'known_usd')::numeric,estimated_usd)) AS known_usd,sum((cost_details->>'image_method'='configured_average')::int) AS image_estimates,count(*) FILTER(WHERE estimated_usd IS NULL) AS unpriced
    FROM tool_usage WHERE created_at>=CURRENT_TIMESTAMP-INTERVAL '62 days' GROUP BY day,tool_key,model,status,image_model ORDER BY day DESC`;
  let rateInfo;try{rateInfo=await exchange.dailyRate();}catch(_){}
  const fx=rateInfo?.rate??null,rows=(await db.query(sql,[exchange.autoEnabled()?null:fx])).rows;
  const state=await budget.summary(db,rateInfo).catch(()=>({blocked:true,reason:'為替情報を取得できません。'}));
  const names=['TOOLS_INPUT_USD_PER_MILLION','TOOLS_CACHED_USD_PER_MILLION','TOOLS_OUTPUT_USD_PER_MILLION','TOOLS_SEARCH_USD_PER_CALL','TOOLS_IMAGE_USD_PER_CALL','TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER'];
  const missing=names.filter(name=>pricing.rate(name)===null);if(fx===null)missing.push('為替情報');
  r.json({rows,exchangeRate:fx,exchangeInfo:rateInfo,budget:state,missingPrices:missing,notice:'このアプリ経由の直近62日分。USDは送信時の設定単価による概算で、実際の請求額ではありません。画像生成は1呼び出しあたりの設定平均額（入力・出力を含む画像モデル分）を加算し、文章モデル分は別途計算します。CSV計算は新規1GBコンテナの料金を加算します。単価・使用量が不明な部分は未算出として区別します。円換算は利用開始日の日本時間の日次レートを保存して計算します。表示中のレートは本日分です。休日は直近の公表レート、取得失敗時は7日以内の保存済みレートを使用します。カード会社の為替・手数料・税は含みません。過去の未算出金額は自動再計算しません。unknown/pendingは追加費用が発生している可能性があります。'});
}));
return router;
}
module.exports=createToolRouter();
module.exports.createToolRouter=createToolRouter;
