const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const fx=require('../src/services/toolExchangeRate'),budget=require('../src/services/toolBudget');
const envRates={TOOLS_INPUT_USD_PER_MILLION:'0.75',TOOLS_CACHED_USD_PER_MILLION:'0.075',TOOLS_OUTPUT_USD_PER_MILLION:'4.5',TOOLS_SEARCH_USD_PER_CALL:'0.01',TOOLS_IMAGE_USD_PER_CALL:'0.1',TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER:'0.03',TOOLS_DAILY_BUDGET_JPY:'100',TOOLS_FX_AUTO_ENABLED:'true'};
test('日本時間の0時で適用日が切り替わる',()=>{assert.equal(fx.dayOf(new Date('2026-11-10T14:59:59Z')),'2026-11-10');assert.equal(fx.dayOf(new Date('2026-11-10T15:00:00Z')),'2026-11-11');});
test('日次レートを固定し、同時取得をまとめ、休日・取得失敗・不正応答を扱う',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
 const before={...process.env},{PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();try{Object.assign(process.env,envRates);await pg.query('CREATE TABLE tool_exchange_rates(day DATE PRIMARY KEY,rate NUMERIC NOT NULL,source TEXT,source_date DATE)');let calls=0;
 const transport=async()=>{calls++;return {ok:true,json:async()=>({date:'2026-11-06',base:'USD',quote:'JPY',rate:150})};};
 const options={day:'2026-11-07',transport,store:pg};const [a,b]=await Promise.all([fx.dailyRate(options),fx.dailyRate(options)]);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.sourceDate,'2026-11-06');
 const fixed=await fx.dailyRate({...options,transport:async()=>{throw new Error('Must not refetch saved rate');}});assert.equal(fixed.rate,150);
 const next=await fx.dailyRate({day:'2026-11-08',store:pg,transport:async()=>{throw new Error('offline');}});assert.equal(next.source,'carry_forward');assert.equal(next.rate,150);
 await assert.rejects(fx.dailyRate({day:'2026-11-20',store:pg,transport}),/為替情報/);
 await assert.rejects(fx.dailyRate({day:'2026-11-01',store:pg,transport:async()=>({ok:true,json:async()=>({date:'2026-11-01',base:'JPY',quote:'USD',rate:0.001})})}),/為替情報/);
 }finally{process.env=before;await pg.close();}
});
test('全ユーザー・全ツール共通100円、処理中の確保、未知料金、翌日再開を検証する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
 const before={...process.env},{PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();try{Object.assign(process.env,envRates);await pg.query('CREATE TABLE tool_usage(id UUID PRIMARY KEY,created_at TIMESTAMPTZ,status TEXT,estimated_usd NUMERIC,estimated_jpy NUMERIC,fx_rate NUMERIC,budget_hold_jpy NUMERIC DEFAULT 0)');
 const info={day:'2026-11-11',rate:150};assert.equal(await budget.reserve(pg,info,'obs-master',false),100);
 const id=randomUUID();await pg.query("INSERT INTO tool_usage(id,created_at,status,budget_hold_jpy) VALUES($1,'2026-11-11 01:00:00+09','pending',100)",[id]);assert.equal((await budget.summary(pg,info)).blocked,true);
 await assert.rejects(budget.reserve(pg,info,'vtube-studio',false),/回答を処理/);
 await pg.query("UPDATE tool_usage SET status='completed',estimated_usd=0.5,estimated_jpy=75 WHERE id=$1",[id]);assert.equal(await budget.reserve(pg,info,'youtube-game-strategy',false),25);
 const id2=randomUUID();await pg.query("INSERT INTO tool_usage(id,created_at,status,estimated_usd,estimated_jpy) VALUES($1,'2026-11-11 02:00:00+09','completed',0.2,30)",[id2]);
 for(const key of ['obs-master','vtube-studio','streaming-gear','kanau','youtube-analyst','youtube-game-strategy'])await assert.rejects(budget.reserve(pg,info,key,key==='kanau'),/明日以降/);
 assert.equal((await budget.summary(pg,{day:'2026-11-12',rate:155})).blocked,false);
 await pg.query('DELETE FROM tool_usage');await pg.query("INSERT INTO tool_usage(id,created_at,status) VALUES($1,'2026-11-11 02:00:00+09','unknown')",[randomUUID()]);assert.equal((await budget.summary(pg,info)).blocked,true);
 delete process.env.TOOLS_IMAGE_USD_PER_CALL;await assert.rejects(budget.reserve(pg,info,'kanau',true),/料金設定/);
 }finally{process.env=before;await pg.close();}
});
test('上限到達時にAPIを呼ばず、履歴は読めて、送信枠を解放する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
 const before={...process.env},{PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database'),obs=require('../src/services/obsMaster');
 const original={query:db.query,connect:db.pool.connect,answer:obs.answer};let server;
 try{Object.assign(process.env,envRates,{TOOLS_FX_AUTO_ENABLED:'false',TOOLS_USD_TO_JPY:'150',JWT_SECRET:'budget-isolated',PAYMENT_ACCESS_CONTROL_ENABLED:'false',OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
 db.query=(sql,p)=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(sql,p);db.pool.connect=async()=>({query:db.query,release(){}});
 await require('../src/models/schema').createTables();const User=require('../src/models/User'),user=await User.create('budget-test','dummy','予算テスト'),jwt=require('jsonwebtoken'),express=require('express'),app=express();app.use(express.json());app.use('/api/tools',require('../src/routes/tools'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/tools',headers={Authorization:'Bearer '+jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET)};
 const thread=await(await fetch(url+'/threads',{method:'POST',headers})).json();
 await pg.query("INSERT INTO tool_usage(id,user_id,status,estimated_usd,estimated_jpy,fx_rate) VALUES($1,$2,'completed',1,150,150)",[randomUUID(),user.id]);let calls=0;obs.answer=async()=>{calls++;throw new Error('Must not reach provider');};
 for(let i=0;i<2;i++){const form=new FormData();form.set('requestId',randomUUID());form.set('text','テスト');const response=await fetch(url+'/threads/'+thread.id+'/messages',{method:'POST',headers,body:form});assert.equal(response.status,429);assert.match((await response.json()).error,/明日以降/);}
 assert.equal(calls,0);assert.equal((await fetch(url+'/threads/'+thread.id,{headers})).status,200);assert.equal((await(await fetch(url+'/config',{headers})).json()).enabled,false);
 const admin=await User.create('budget-admin','dummy','予算管理テスト','管理者');process.env.TOOLS_USD_TO_JPY='200';const adminHeaders={Authorization:'Bearer '+jwt.sign({id:admin.id,role:admin.role},process.env.JWT_SECRET)};const report=await(await fetch(url+'/usage',{headers:adminHeaders})).json();assert.equal(Number(report.rows[0].estimated_jpy),150);assert.equal(report.exchangeRate,200);

 }finally{if(server)await new Promise(r=>server.close(r));db.query=original.query;db.pool.connect=original.connect;obs.answer=original.answer;process.env=before;await pg.close();}
});
