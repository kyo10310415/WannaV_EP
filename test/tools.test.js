const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const obs=require('../src/services/obsMaster');
test('添付は形式・容量・UTF-8・危険な種類を検証する',()=>{
  assert.equal(obs.attachment({originalname:'obs.log',buffer:Buffer.from('OBS log')}).kind,'log');
  assert.equal(obs.attachment({originalname:'x.png',buffer:Buffer.from([137,80,78,71,13,10,26,10])}).kind,'image');
  for(const [name,buffer] of [['x.html',Buffer.from('<script>')],['x.log',Buffer.from([255])],['x.log',Buffer.alloc(100001)],['x.png',Buffer.alloc(2*1024*1024+1)]]) assert.throws(()=>obs.attachment({originalname:name,buffer}));
  assert.equal(obs.safeUrl('javascript:alert(1)'),null);assert.equal(obs.safeUrl('https://user:pass@example.com'),null);
});
test('料金は設定なしでは推測せず、キャッシュ・検索を分けて概算する',()=>{
  const env={...process.env};try{
    for(const key of Object.keys(process.env))if(key.startsWith('TOOLS_'))delete process.env[key];
    const usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:200}};
    assert.equal(obs.estimate(usage,2),null);
    Object.assign(process.env,{TOOLS_INPUT_USD_PER_MILLION:'2',TOOLS_CACHED_USD_PER_MILLION:'1',TOOLS_OUTPUT_USD_PER_MILLION:'10',TOOLS_SEARCH_USD_PER_CALL:'0.01'});
    assert.ok(Math.abs(obs.estimate(usage,2)-.0228)<1e-9);
  }finally{process.env=env;}
});
test('Responses呼び出しは画像・ログ・指示・必須検索・保存無効を使用し出典URLを検証する',async()=>{
  const env={...process.env};try{process.env.OPENAI_API_KEY='test-key';process.env.OPENAI_OBS_MODEL='test-model';
    const result=await obs.answer([{role:'user',text:'1',attachments:[{kind:'log',data:Buffer.from('log')},{kind:'image',mime:'image/png',data:Buffer.from('dummy')}]}],async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
      assert.equal(body.store,false);assert.equal(body.tool_choice,'required');assert.equal(body.tools[0].type,'web_search');assert.equal(body.input[0].content[2].type,'input_image');assert.match(body.instructions,/該当しない/);
      return {ok:true,json:async()=>({status:'completed',model:'test-model',usage:{input_tokens:100,output_tokens:30},output:[{type:'web_search_call'},{type:'message',content:[{type:'output_text',text:'回答',annotations:[{type:'url_citation',url:'https://obsproject.com',title:'公式情報'},{type:'url_citation',url:'javascript:x'}]}]}]})};
    });assert.equal(result.searches,1);assert.equal(result.citations.length,1);assert.equal(result.complete,true);
  }finally{process.env=env;}
});
test('本人限定の会話・添付・削除、管理者限定集計、二重課金防止、使用量を隔離DBで検証',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),oldQuery=db.query,oldConnect=db.pool.connect,oldAnswer=obs.answer,env={...process.env};let server;
  db.query=(sql,p)=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(sql,p);
  db.pool.connect=async()=>({query:db.query,release(){}});
  try{Object.assign(process.env,{JWT_SECRET:'isolated-tools-test',PAYMENT_ACCESS_CONTROL_ENABLED:'false',OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
    await require('../src/models/schema').createTables();const User=require('../src/models/User');
    const a=await User.create('tool-a','dummy','テストA'),b=await User.create('tool-b','dummy','テストB'),admin=await User.create('tool-admin','dummy','テスト管理者','管理者');
    const jwt=require('jsonwebtoken'),token=u=>jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET),express=require('express'),app=express();app.use(express.json());app.use('/api/tools',require('../src/routes/tools'));
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(p,u=a,method='GET',body)=>fetch(base+p,{method,headers:u?{Authorization:'Bearer '+token(u)}:{},body});
    assert.equal((await req('/threads',null)).status,401);assert.equal((await req('/usage',a)).status,403);
    const thread=await (await req('/threads',a,'POST')).json();assert.equal((await req('/threads/'+thread.id,b)).status,404);
    let calls=0;obs.answer=async messages=>{calls++;assert.equal(messages[0].attachments[0].data.toString(),'test log');return {complete:true,text:'1. 結論\n回答',citations:[],usage:{input_tokens:50,output_tokens:20},searches:1,model:'test-model',usd:null};};
    const rid=randomUUID(),form=(id=rid)=>{const f=new FormData();f.set('text','相談');f.set('requestId',id);f.append('attachments',new Blob(['test log'],{type:'text/plain'}),'obs.log');return f;};
    assert.equal((await req('/threads/'+thread.id+'/messages',a,'POST',form())).status,200);
    assert.equal((await req('/threads/'+thread.id+'/messages',a,'POST',form())).status,409);assert.equal(calls,1);
    const detail=await(await req('/threads/'+thread.id)).json();assert.equal(detail.messages.length,2);const attachment=detail.messages[0].attachments[0].id;
    assert.equal((await req('/attachments/'+attachment,b)).status,404);assert.equal(await(await req('/attachments/'+attachment)).text(),'test log');
    const report=await(await req('/usage',admin)).json();assert.equal(Number(report.rows[0].input_tokens),50);assert.equal(report.rows[0].estimated_usd,null);
    process.env.TOOLS_USD_TO_JPY='150';
    await pg.query('UPDATE tool_usage SET cost_details=$2 WHERE id=$1',[rid,JSON.stringify({known_usd:0.03,image_method:'configured_average'})]);
    const pricedId=randomUUID();await pg.query("INSERT INTO tool_usage(id,user_id,tool_key,model,status,estimated_usd) VALUES($1,$2,'obs-master','test-model','completed',0.02)",[pricedId,a.id]);
    const partialReport=await(await req('/usage',admin)).json(),partial=partialReport.rows[0];
    assert.equal(partialReport.exchangeRate,150);assert.equal(Number(partial.known_usd),0.05);assert.equal(Number(partial.known_jpy),7.5);assert.equal(Number(partial.unpriced),1);assert.equal(Number(partial.image_estimates),1);
    assert.ok(partialReport.missingPrices.includes('TOOLS_IMAGE_USD_PER_CALL'));
    await pg.query('DELETE FROM tool_usage WHERE id=$1',[pricedId]);

    delete process.env.OPENAI_API_KEY;assert.equal((await req('/threads/'+thread.id+'/messages',a,'POST',form(randomUUID()))).status,503);process.env.OPENAI_API_KEY='dummy';
    await pg.query("UPDATE tool_threads SET busy_until=CURRENT_TIMESTAMP+INTERVAL '3 minutes' WHERE id=$1",[thread.id]);
    assert.equal((await req('/threads/'+thread.id+'/messages',a,'POST',form(randomUUID()))).status,409);assert.equal(calls,1);
    await pg.query('UPDATE tool_threads SET busy_until=NULL WHERE id=$1',[thread.id]);
    obs.answer=async()=>{calls++;throw new Error('private provider failure');};
    const failed=await req('/threads/'+thread.id+'/messages',a,'POST',form(randomUUID()));assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/private provider/);assert.equal(calls,2);
    assert.equal(Number((await pg.query("SELECT count(*) AS n FROM tool_usage WHERE status='unknown'")).rows[0].n),1);
    for(let i=0;i<28;i++)await pg.query("INSERT INTO tool_usage(id,user_id,status) VALUES($1,$2,'unknown')",[randomUUID(),a.id]);
    assert.equal((await req('/threads/'+thread.id+'/messages',a,'POST',form(randomUUID()))).status,429);assert.equal(calls,2);
    assert.equal((await req('/threads/'+thread.id,b,'DELETE')).status,404);assert.equal((await req('/threads/'+thread.id,a,'DELETE')).status,200);
    assert.equal((await req('/attachments/'+attachment)).status,404);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_attachments')).rows[0].n),0);
    assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_usage')).rows[0].n),30);
  }finally{obs.answer=oldAnswer;db.query=oldQuery;db.pool.connect=oldConnect;process.env=env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
