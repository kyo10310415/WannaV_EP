const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path');
const kanau=require('../src/services/kanau'),obs=require('../src/services/obsMaster');
const webp=()=>Buffer.from('RIFF0000WEBPdummy-image');
test('立ち絵と希望を画像生成ツールへ渡し、内部分析は出さず画像と制作プロンプトを返す',async()=>{
  const env={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'test',OPENAI_OBS_MODEL:'test-model',OPENAI_KANAU_IMAGE_MODEL:'test-image-model'});
    const messages=[{role:'user',text:'髪と衣装は維持、初配信のサムネイル',metadata:{size:'1536x864'},attachments:[{kind:'image',mime:'image/webp',data:webp()}]}];
    const transport=async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.tools[0].type,'image_generation');assert.equal(body.tools[0].model,'test-image-model');assert.equal(body.tools[0].action,'edit');assert.equal(body.tools[0].size,'1536x864');assert.equal(body.tools[0].output_format,'webp');assert.equal(body.store,false);assert.equal(body.max_tool_calls,1);
      assert.ok(body.input[0].content[1].image_url.startsWith('data:image/webp;base64,'));for(const key of ['髪型','髪色','瞳','衣装','小物','表情','色味','世界観','印象','内部'])assert.ok(body.instructions.includes(key));
      return {ok:true,json:async()=>({status:'completed',model:'test-model',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:'INTERNAL_ANALYSIS_MUST_NOT_DISPLAY'}]},{type:'image_generation_call',status:'completed',result:webp().toString('base64'),revised_prompt:'特徴を維持した制作プロンプト'}]})};};
    const result=await kanau.answer(messages,transport);assert.equal(result.complete,true);assert.equal(result.images.length,1);assert.equal(result.imageCalls,1);assert.equal(result.usd,null);assert.equal(result.usageKnown,true);assert.match(result.text,/制作プロンプト/);assert.doesNotMatch(result.text,/INTERNAL_ANALYSIS/);
    await assert.rejects(kanau.answer([{role:'user',text:'画像だけ作って',attachments:[]}],transport),/REFERENCE_REQUIRED/);
    delete process.env.OPENAI_KANAU_IMAGE_MODEL;assert.equal(kanau.config().enabled,false);assert.equal(obs.config().enabled,true);
  }finally{process.env=env;}
});
test('不正な画像や未完了を成功扱いせず、使用量欠落をゼロ円としない',async()=>{
  const env={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'test',OPENAI_OBS_MODEL:'test',OPENAI_KANAU_IMAGE_MODEL:'test'});
    const messages=[{role:'user',text:'希望',attachments:[{kind:'image',mime:'image/webp',data:webp()}]}];
    const result=await kanau.answer(messages,async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'image_generation_call',status:'completed',result:Buffer.from('<script>').toString('base64')}]})}));
    assert.equal(result.complete,false);assert.equal(result.images.length,0);assert.equal(result.usageKnown,false);assert.equal(result.usd,null);
    await assert.rejects(kanau.answer(messages,async()=>({ok:false})),/PROVIDER_ERROR/);
  }finally{process.env=env;}
});
test('かなうさんのカード・画像サイズ・生成画像表示・ダウンロードを用意する',()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');assert.match(read('views/tools.html'),/href="\/tools\/kanau"/);
  const html=read('views/kanau.html');assert.match(html,/data-tool="kanau"/);assert.match(html,/id="tool-size"/);assert.match(html,/立ち絵必須/);assert.match(html,/<th>画像生成回数<\/th>/);
  assert.match(read('public/js/tools.js'),/URL\.revokeObjectURL/);assert.match(read('public/js/tools.js'),/画像をダウンロード/);
  const img=fs.readFileSync(path.join(__dirname,'../public/images/tools/kanau.webp'));assert.equal(img.toString('ascii',8,12),'WEBP');
});
test('初回の立ち絵必須・本人限定の生成物・履歴分離・再制作・日次上限・削除を隔離DBで確認',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database');
  const old={query:db.query,connect:db.pool.connect,answer:kanau.answer,env:{...process.env}};let server;
  db.query=(s,p)=>s.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(s,p);db.pool.connect=async()=>({query:db.query,release(){}});
  // This fixture covers tool ownership/quotas; FX and shared budgets have dedicated suites.
  try{Object.assign(process.env,{TOOLS_FX_AUTO_ENABLED:'false',TOOLS_USD_TO_JPY:'150',TOOLS_DAILY_BUDGET_JPY:'off',JWT_SECRET:'isolated-kanau',PAYMENT_ACCESS_CONTROL_ENABLED:'false',OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model',OPENAI_KANAU_IMAGE_MODEL:'test-image-model'});
    await require('../src/models/schema').createTables();const User=require('../src/models/User'),a=await User.create('kanau-a','dummy','生徒A'),b=await User.create('kanau-b','dummy','生徒B'),admin=await User.create('kanau-admin','dummy','管理者','管理者');
    const express=require('express'),jwt=require('jsonwebtoken'),router=require('../src/routes/tools'),app=express();app.use(express.json());app.use('/api/tools/kanau',router.createToolRouter('kanau'));app.use('/api/tools',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(p,u=a,method='GET',body)=>fetch(base+p,{method,headers:u?{Authorization:'Bearer '+jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET)}:{},body});
    const thread=await(await req('/kanau/threads',a,'POST')).json(),rid=randomUUID();
    const form=(image=false,id=randomUUID(),size='1536x864',log=false)=>{const f=new FormData();f.set('text','初配信サムネイルを作成');f.set('requestId',id);f.set('size',size);if(image)f.append('attachments',new Blob([webp()]),'reference.webp');if(log)f.append('attachments',new Blob(['log']),'x.log');return f;};
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form())).status,400);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_usage')).rows[0].n),0);
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form(true,randomUUID(),'bad'))).status,400);
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form(false,randomUUID(),'1536x864',true))).status,400);
    let calls=0;kanau.answer=async messages=>{calls++;assert.equal(messages.at(-1).metadata.size,'1536x864');if(calls===2)assert.ok(messages.some(m=>m.role==='assistant'&&m.attachments.some(x=>x.kind==='generated')));
      return {complete:true,text:'画像と制作プロンプト',citations:[],images:[{name:'kanau.webp',kind:'generated',mime:'image/webp',data:webp()}],usage:{input_tokens:20,output_tokens:10},usageKnown:true,imageCalls:1,imageModel:'test-image-model',model:'test-model',searches:0,usd:null};};
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form(true,rid))).status,200);
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form(true,rid))).status,409);assert.equal(calls,1);
    const detail=await(await req('/kanau/threads/'+thread.id)).json(),generated=detail.messages.find(x=>x.role==='assistant').attachments[0];assert.equal(generated.kind,'generated');
    assert.equal((await req('/kanau/attachments/'+generated.id,b)).status,404);assert.equal((await req('/attachments/'+generated.id)).status,404);
    assert.equal((await req('/kanau/attachments/'+generated.id)).headers.get('content-type'),'image/webp');assert.equal((await req('/kanau/threads/'+thread.id,b)).status,404);assert.equal((await req('/threads/'+thread.id)).status,404);
    const report=await(await req('/usage',admin)).json();assert.equal(report.rows[0].tool_key,'kanau');assert.equal(Number(report.rows[0].image_calls),1);assert.equal(report.rows[0].image_model,'test-image-model');assert.equal(report.rows[0].estimated_usd,null);
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form())).status,200);assert.equal(calls,2);
    await pg.query("INSERT INTO tool_usage(id,user_id,tool_key,status) VALUES($1,$2,'kanau','unknown')",[randomUUID(),a.id]);
    assert.equal((await req('/kanau/threads/'+thread.id+'/messages',a,'POST',form())).status,429);assert.equal(calls,2);
    assert.equal((await req('/kanau/threads/'+thread.id,a,'DELETE')).status,200);assert.equal((await req('/kanau/attachments/'+generated.id)).status,404);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_attachments')).rows[0].n),0);
  }finally{db.query=old.query;db.pool.connect=old.connect;kanau.answer=old.answer;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
