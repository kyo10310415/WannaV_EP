const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path');
const obs=require('../src/services/obsMaster'),vts=require('../src/services/vtubeStudioMaster');
test('既存ツール識別列がないDBを移行してもOBSの履歴と使用量を保持する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database'),original=db.query;
  db.query=(s,p)=>pg.query(s,p);
  try{
    await pg.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);
      CREATE TABLE tool_threads(id UUID PRIMARY KEY,user_id INTEGER,title TEXT,created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE tool_usage(id UUID PRIMARY KEY,user_id INTEGER,created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);`);
    const id=randomUUID(),usage=randomUUID();await pg.query('INSERT INTO tool_threads(id,user_id,title) VALUES($1,1,$2)',[id,'以前のOBS相談']);await pg.query('INSERT INTO tool_usage(id,user_id) VALUES($1,1)',[usage]);
    await require('../src/models/toolSchema')();await require('../src/models/toolSchema')();
    const row=(await pg.query('SELECT * FROM tool_threads WHERE id=$1',[id])).rows[0];assert.equal(row.title,'以前のOBS相談');assert.equal(row.tool_key,'obs-master');
    assert.equal((await pg.query('SELECT tool_key FROM tool_usage WHERE id=$1',[usage])).rows[0].tool_key,'obs-master');
  }finally{db.query=original;await pg.close();}
});
test('VTube Studio専用の指示と既存モデル設定を使い、OBSの指示を上書きしない',async()=>{
  const env={...process.env};try{process.env.OPENAI_API_KEY='test';process.env.OPENAI_OBS_MODEL='test-model';
    assert.equal(vts.config().model,'test-model');
    await vts.answer([{role:'user',text:'2'}],async(_url,o)=>{
      const body=JSON.parse(o.body);assert.equal(body.instructions,vts.PROMPT);assert.notEqual(body.instructions,obs.PROMPT);
      for(const term of ['DenchiSoft','VTS-Heartrate','Live2D','iOS/Android','送ってほしい情報','該当しない','バックアップ'])assert.ok(body.instructions.includes(term));
      assert.equal(body.tool_choice,'required');assert.equal(body.store,false);
      return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:5,output_tokens:5},output:[{type:'message',content:[{type:'output_text',text:'VTS回答'}]}]})};
    });
    assert.match(obs.PROMPT,/OBS Studio専門/);
  }finally{process.env=env;}
});
test('カード・専用画面・サムネイル・使用量列が存在する',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../views/vtube-studio-master.html'),'utf8');
  assert.match(html,/data-tool="vtube-studio"/);assert.match(html,/<th>ツール<\/th>/);assert.match(html,/src="\/js\/tools.js"/);
  const catalog=fs.readFileSync(path.join(__dirname,'../views/tools.html'),'utf8');assert.match(catalog,/href="\/tools\/vtube-studio"/);
  const image=fs.readFileSync(path.join(__dirname,'../public/images/tools/vtube-studio-master.webp'));assert.equal(image.toString('ascii',8,12),'WEBP');
});
test('ツール間の履歴・添付・送信・削除を分離し、使用量と日次上限は両ツールを集計',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database');
  const old={query:db.query,connect:db.pool.connect,obs:obs.answer,vts:vts.answer,env:{...process.env}};let server;
  db.query=(s,p)=>s.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(s,p);db.pool.connect=async()=>({query:db.query,release(){}});
  try{Object.assign(process.env,{JWT_SECRET:'isolated-vts',PAYMENT_ACCESS_CONTROL_ENABLED:'false',OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
    await require('../src/models/schema').createTables();const User=require('../src/models/User'),a=await User.create('vts-a','dummy','生徒A'),b=await User.create('vts-b','dummy','生徒B'),admin=await User.create('vts-admin','dummy','管理者','管理者');
    const express=require('express'),jwt=require('jsonwebtoken'),router=require('../src/routes/tools'),app=express();app.use(express.json());app.use('/api/tools/vtube-studio',router.createToolRouter('vtube-studio'));app.use('/api/tools',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const root='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(tool,p,u=a,method='GET',body)=>fetch(root+(tool==='vts'?'/vtube-studio':'')+p,{method,headers:u?{Authorization:'Bearer '+jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET)}:{},body});
    const ot=await(await req('obs','/threads',a,'POST')).json(),vt=await(await req('vts','/threads',a,'POST')).json();
    assert.deepEqual((await(await req('obs','/threads')).json()).map(x=>x.id),[ot.id]);assert.deepEqual((await(await req('vts','/threads')).json()).map(x=>x.id),[vt.id]);
    await require('../src/models/toolSchema')();assert.equal((await req('obs','/threads/'+ot.id)).status,200);
    const form=()=>{const f=new FormData();f.set('text','VTS接続相談');f.set('requestId',randomUUID());f.append('attachments',new Blob(['private log']),'vts.log');return f;};
    for(const [tool,id] of [['vts',ot.id],['obs',vt.id]])for(const method of ['GET','DELETE','POST'])assert.equal((await req(tool,'/threads/'+id+(method==='POST'?'/messages':''),a,method,method==='POST'?form():undefined)).status,404);
    assert.equal((await req('vts','/threads/'+vt.id,b)).status,404);assert.equal((await req('vts','/threads',null)).status,401);
    let oc=0,vc=0;const result={complete:true,text:'回答',citations:[],usage:{input_tokens:20,output_tokens:10},searches:1,model:'test-model',usd:null};
    obs.answer=async()=>{oc++;return result;};vts.answer=async messages=>{vc++;assert.equal(messages.length,1);assert.equal(messages[0].attachments[0].data.toString(),'private log');return result;};
    assert.equal((await req('vts','/threads/'+vt.id+'/messages',a,'POST',form())).status,200);assert.equal(vc,1);assert.equal(oc,0);
    const detail=await(await req('vts','/threads/'+vt.id)).json(),aid=detail.messages.find(m=>m.role==='user').attachments[0].id;
    assert.equal((await req('obs','/attachments/'+aid)).status,404);assert.equal((await req('vts','/attachments/'+aid,b)).status,404);assert.equal(await(await req('vts','/attachments/'+aid)).text(),'private log');
    assert.equal((await req('obs','/threads/'+ot.id+'/messages',a,'POST',form())).status,200);assert.equal(oc,1);
    const report=await(await req('obs','/usage',admin)).json();assert.deepEqual(report.rows.map(x=>x.tool_key).sort(),['obs-master','vtube-studio']);
    assert.equal((await req('vts','/usage',a)).status,403);
    for(let i=0;i<28;i++)await pg.query("INSERT INTO tool_usage(id,user_id,tool_key,status) VALUES($1,$2,$3,'unknown')",[randomUUID(),a.id,i%2?'obs-master':'vtube-studio']);
    for(const [tool,id] of [['obs',ot.id],['vts',vt.id]])assert.equal((await req(tool,'/threads/'+id+'/messages',a,'POST',form())).status,429);
    assert.equal((await req('vts','/threads/'+vt.id,a,'DELETE')).status,200);assert.equal((await req('vts','/attachments/'+aid)).status,404);assert.equal((await req('obs','/threads/'+ot.id)).status,200);
  }finally{db.query=old.query;db.pool.connect=old.connect;obs.answer=old.obs;vts.answer=old.vts;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
