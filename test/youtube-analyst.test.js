const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path');
const analyst=require('../src/services/youtubeAnalyst'),kanau=require('../src/services/kanau');
const webp=()=>Buffer.from('RIFF0000WEBPdummy-image');
const env=()=>Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model',OPENAI_KANAU_IMAGE_MODEL:'test-image-model'});
test('分析は画像モデルなしで動き、CSV・画像を送り検索・画像生成を呼ばない',async()=>{
  const before={...process.env};try{env();delete process.env.OPENAI_KANAU_IMAGE_MODEL;
    assert.equal(analyst.config().enabled,true);assert.equal(analyst.config().imageEnabled,false);
    const csv=analyst.attachment({originalname:'analytics.csv',buffer:Buffer.from('タイトル,CTR\n初配信,4.5%')});
    const result=await analyst.answer([{role:'user',text:'直近28日の通常動画を分析',metadata:{mode:'analyze'},attachments:[csv,{kind:'image',mime:'image/webp',data:webp()}]}],async(_url,options)=>{
      const body=JSON.parse(options.body);assert.equal(body.tools,undefined);assert.equal(body.store,false);assert.equal(body.model,'test-model');
      assert.match(body.input[0].content[1].text,/初配信,4.5%/);assert.match(body.input[0].content[2].image_url,/^data:image\/webp;base64,/);
      for(const word of ['不足情報','結論','良い点','改善点','ネクストアクション','Shorts','低コスト','欠損値','仮説'])assert.ok(body.instructions.includes(word));
      return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:30,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:'分析対象の期間を教えてください'}]}]})};
    });assert.equal(result.complete,true);assert.equal(result.text,'分析対象の期間を教えてください');assert.equal(result.searches,0);
  }finally{process.env=before;}
});
test('CSVはUTF-8と容量を検査し、既存ツールの添付条件は広げない',()=>{
  for(const buffer of [Buffer.alloc(0),Buffer.alloc(100001,65),Buffer.from([0x81,0x82]),Buffer.from('a\0b')])assert.throws(()=>analyst.attachment({originalname:'x.csv',buffer}),/UTF-8/);
  assert.throws(()=>analyst.attachment({originalname:'x.xlsx',buffer:Buffer.from('data')}));
  assert.throws(()=>require('../src/services/obsMaster').attachment({originalname:'x.csv',buffer:Buffer.from('CTR,4%')}));
  assert.equal(analyst.attachment({originalname:'x.csv',buffer:Buffer.from('title,value\n=1+1,2')}).data.toString(),'title,value\n=1+1,2');
});
test('改善画像モードは情報不足なら質問のみを返し、生成は1枚、失敗を成功扱いしない',async()=>{
  const before={...process.env};try{env();
    const messages=[{role:'user',text:'このサムネを改善',metadata:{mode:'thumbnail',size:'1536x864'},attachments:[{kind:'image',mime:'image/webp',data:webp()},{kind:'csv',data:Buffer.from('CTR,4.5%')}]}];
    let output=[{type:'message',content:[{type:'output_text',text:'動画タイトルと内容を教えてください'}]}];
    const transport=async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.tool_choice,'auto');assert.equal(body.max_tool_calls,1);assert.equal(body.tools[0].size,'1536x864');assert.equal(body.tools[0].model,'test-image-model');assert.match(body.instructions,/右下/);assert.match(body.instructions,/まず質問/);assert.match(body.input[0].content[2].text,/CTR,4.5%/);
      return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:10,output_tokens:10},output})};};
    let result=await analyst.answer(messages,transport);assert.equal(result.complete,true);assert.deepEqual(result.images,[]);assert.equal(result.imageCalls,0);assert.equal(result.usd,null);assert.doesNotMatch(result.text,/作成しました/);
    output=[{type:'image_generation_call',status:'completed',result:webp().toString('base64')}];result=await analyst.answer(messages,transport);assert.equal(result.complete,true);assert.equal(result.images[0].name,'youtube-thumbnail.webp');assert.equal(result.imageCalls,1);
    output=[{type:'message',content:[{type:'output_text',text:'できました'}]},{type:'image_generation_call',status:'failed',result:'bad'}];result=await analyst.answer(messages,transport);assert.equal(result.complete,false);
  }finally{process.env=before;}
});
test('生成済みサムネイルを分析に戻したときも画像として参照する',async()=>{
  const before={...process.env};try{env();await analyst.answer([{role:'assistant',text:'作成済み',attachments:[{kind:'generated',mime:'image/webp',data:webp()}]},{role:'user',text:'文字は読みやすい？',metadata:{mode:'analyze'},attachments:[]}],async(_u,o)=>{
    const body=JSON.parse(o.body);assert.match(body.input[0].content[1].image_url,/^data:image\/webp/);
    return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:10,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:'確認しました'}]}]})};
  });}finally{process.env=before;}
});
test('専用カード・サムネイル・相談モードを用意する',()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');assert.match(read('views/tools.html'),/href="\/tools\/youtube-analyst"/);
  const html=read('views/youtube-analyst.html');assert.match(html,/data-tool="youtube-analyst"/);assert.match(html,/value="analyze"/);assert.match(html,/value="thumbnail"/);assert.match(html,/\.csv/);assert.match(html,/tool-markdown.js/);
  const image=fs.readFileSync(path.join(__dirname,'../public/images/tools/youtube-analyst.webp'));assert.equal(image.toString('ascii',8,12),'WEBP');
});
test('隔離DB：分析・画像の切替、履歴分離、本人制御、集計、共通画像上限、削除',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database');
  const old={query:db.query,connect:db.pool.connect,answer:analyst.answer,env:{...process.env}};let server;
  db.query=(s,p)=>s.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(s,p);db.pool.connect=async()=>({query:db.query,release(){}});
  // This fixture covers tool ownership/quotas; FX and shared budgets have dedicated suites.
  try{env();Object.assign(process.env,{TOOLS_FX_AUTO_ENABLED:'false',TOOLS_USD_TO_JPY:'150',TOOLS_DAILY_BUDGET_JPY:'off',JWT_SECRET:'isolated-youtube',PAYMENT_ACCESS_CONTROL_ENABLED:'false'});
    await require('../src/models/schema').createTables();const User=require('../src/models/User'),a=await User.create('youtube-a','dummy','生徒A'),b=await User.create('youtube-b','dummy','生徒B'),admin=await User.create('youtube-admin','dummy','管理者','管理者');
    const express=require('express'),jwt=require('jsonwebtoken'),router=require('../src/routes/tools'),app=express();app.use(express.json());
    for(const key of ['vtube-studio','streaming-gear','kanau','youtube-analyst'])app.use('/api/tools/'+key,router.createToolRouter(key));app.use('/api/tools',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(p,u=a,method='GET',body)=>fetch(base+p,{method,headers:u?{Authorization:'Bearer '+jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET)}:{},body});
    const thread=await(await req('/youtube-analyst/threads',a,'POST')).json(),rid=randomUUID();
    const form=(mode='analyze',image=false,csvs=0,id=randomUUID())=>{const f=new FormData();f.set('text','直近28日、初配信のサムネを改善');f.set('requestId',id);f.set('mode',mode);if(image)f.append('attachments',new Blob([webp()]),'reference.webp');for(let i=0;i<csvs;i++)f.append('attachments',new Blob(['title,CTR\n初配信,4.5%']),'report'+i+'.csv');return f;};
    assert.equal((await req('/youtube-analyst/threads/'+thread.id,null)).status,401);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id,b)).status,404);
    for(const key of ['','/vtube-studio','/streaming-gear','/kanau'])assert.equal((await req(key+'/threads/'+thread.id)).status,404);
    let calls=0;analyst.answer=async messages=>{calls++;const image=messages.at(-1).metadata.mode==='thumbnail';return {complete:true,text:image?'改善画像':'分析回答',citations:[],images:image?[{name:'youtube-thumbnail.webp',kind:'generated',mime:'image/webp',data:webp()}]:undefined,usage:{input_tokens:20,output_tokens:10},usageKnown:true,imageCalls:image?1:undefined,imageModel:image?'test-image-model':undefined,model:'test-model',searches:0,usd:null};};
    delete process.env.OPENAI_KANAU_IMAGE_MODEL;
    assert.deepEqual(await(await req('/youtube-analyst/config')).json(),{enabled:true,imageEnabled:false});
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('thumbnail',true))).status,503);assert.equal(calls,0);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('analyze',false,3,rid))).status,200);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('analyze',false,3,rid))).status,409);assert.equal(calls,1);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('bad'))).status,400);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('analyze',false,4))).status,400);
    process.env.OPENAI_KANAU_IMAGE_MODEL='test-image-model';
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('thumbnail',false,1))).status,400);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('thumbnail',true))).status,200);assert.equal(calls,2);
    const detail=await(await req('/youtube-analyst/threads/'+thread.id)).json(),image=detail.messages.find(m=>m.attachments.some(x=>x.kind==='generated')).attachments[0];
    assert.equal((await req('/youtube-analyst/attachments/'+image.id,b)).status,404);assert.equal((await req('/kanau/attachments/'+image.id)).status,404);assert.equal((await req('/youtube-analyst/attachments/'+image.id)).headers.get('content-type'),'image/webp');
    assert.equal((await req('/youtube-analyst/usage')).status,403);
    const rows=(await(await req('/usage',admin)).json()).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.tool_key==='youtube-analyst'));assert.equal(Number(rows.find(r=>r.image_model).image_calls),1);assert.equal(rows.find(r=>!r.image_model).image_calls,null);
    await pg.query("INSERT INTO tool_usage(id,user_id,tool_key,status) VALUES($1,$2,'kanau','unknown'),($3,$2,'kanau','unknown')",[randomUUID(),a.id,randomUUID()]);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form('thumbnail'))).status,429);assert.equal(calls,2);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id+'/messages',a,'POST',form())).status,200);assert.equal(calls,3);
    const other=await(await req('/kanau/threads',a,'POST')).json(),kf=new FormData();kf.set('text','生成');kf.set('requestId',randomUUID());kf.append('attachments',new Blob([webp()]),'reference.webp');
    assert.equal((await req('/kanau/threads/'+other.id+'/messages',a,'POST',kf)).status,429);
    assert.equal((await req('/youtube-analyst/threads/'+thread.id,a,'DELETE')).status,200);assert.equal((await req('/youtube-analyst/attachments/'+image.id)).status,404);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_attachments')).rows[0].n),0);
  }finally{db.query=old.query;db.pool.connect=old.connect;analyst.answer=old.answer;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
