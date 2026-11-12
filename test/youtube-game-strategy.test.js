const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path');
const game=require('../src/services/youtubeGameStrategy');
const csv=i=>game.attachment({originalname:'different-name-'+i+'.csv',buffer:Buffer.from('Content,Metric'+i+'\nvideo1,'+i)});
const ready=(mode='②')=>[{role:'user',text:mode,attachments:[]},{role:'user',text:'https://www.youtube.com/@test-channel PRIVATE_CONVERSATION_SENTINEL',attachments:[csv(1),csv(2),csv(3)]}];
const setup=()=>Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
function provider({auditReady=true,code=true,search=true,failStage=0,wrongMode=false}={}){
  const calls=[];let file=0,response=0;
  const transport=async(url,options)=>{
    const body=options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):null;calls.push({url,options,body});
    const ok=data=>({ok:true,json:async()=>data});if(options.method==='DELETE')return ok({deleted:true});
    if(url.endsWith('/containers'))return ok({id:'cntr_test'});
    if(url.endsWith('/files')&&body instanceof FormData)return ok({id:'file-test'+(++file)});
    if(url.endsWith('/containers/cntr_test/files'))return ok({id:'cfile_test',path:'/mnt/data/random-prefix-analytics-'+file+'.csv'});
    assert.ok(url.endsWith('/responses'));response++;if(response===failStage)throw new Error('network failed');
    const message=text=>({type:'message',content:[{type:'output_text',text,annotations:response===2&&search?[{type:'url_citation',url:'https://example.com/game-release',title:'公式リリース'}]:[]}]});
    return ok({status:'completed',usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:2}},output:response===1?[...(code?[{type:'code_interpreter_call',status:'completed'}]:[]),message(JSON.stringify({ready:auditReady,question:'3種類のCSVの役割と対象期間を教えてください',report:'Python計算結果：n=3、合計視聴回数300、欠損なし'}))]:response===2?[...(search?[{type:'web_search_call',status:'completed'}]:[]),message('公開ゲーム情報：公式で更新日を確認')]:[message(wrongMode?'## 結論\n次の10配信で仮説を検証します。':'## 結論\n## 新規候補\nテスト候補\n## 最優先テスト\n次の10配信で仮説を検証します。')]});
  };return {calls,transport};
}
test('初回は指定文だけ、モード・URL・内容が異なるCSV3つが揃うまではAPIを呼ばない',async()=>{
  const transport=()=>{throw new Error('must not call');};
  assert.equal((await game.answer([],transport)).text,game.INTRO);
  assert.equal((await game.answer([ready()[1]],transport)).text,game.INTRO);
  const selected=await game.answer([{role:'user',text:'①',attachments:[]}],transport);assert.ok(selected.text.startsWith(game.REQUEST));assert.equal(selected.model,'local-intake');assert.equal(selected.usd,0);
  const duplicates=ready();duplicates[1].attachments=[csv(1),csv(1),csv(2)];assert.match((await game.answer(duplicates,transport)).text,/CSV 2\/3/);
  assert.equal(game.intake([...ready('①'),{role:'user',text:'②'}]).mode,'discovery');
  assert.match((await game.answer([...ready(),{role:'user',text:'https://youtube.com/@another'}],transport)).text,/新しい相談/);
  assert.match((await game.answer([...ready(),{role:'user',text:'追加',attachments:[csv(4)]}],transport)).text,/新しい相談/);
});
test('YouTubeチャンネルURLを正規化し、外部URL・動画URL・認証付きURLは採用しない',()=>{
  assert.equal(game.channelUrl('https://youtube.com/@test?secret=do-not-forward'),'https://www.youtube.com/@test');
  for(const text of ['https://youtube.com.evil.test/@x','http://youtube.com/@x','https://youtu.be/video','https://youtube.com/watch?v=abc','https://user:pass@youtube.com/@x'])assert.equal(game.channelUrl(text),null);
});
test('CSVのみを検証し、Shift-JISをUTF-8へ補正する。ファイル名で種類を決めない',()=>{
  assert.equal(csv(1).kind,'csv');
  const decoded=game.attachment({originalname:'anything.csv',buffer:Buffer.from([0x96,0xbc,0x91,0x4f,0x2c,0x78,0x0a,0x61,0x2c,0x31])});assert.equal(decoded.data.toString(),'名前,x\na,1');
  for(const f of [{originalname:'x.xlsx',buffer:Buffer.from('a,b\n1,2')},{originalname:'x.csv',buffer:Buffer.alloc(2*1024*1024+1,65)},{originalname:'x.csv',buffer:Buffer.from('a,b\nx,\0')},{originalname:'x.csv',buffer:Buffer.from('not a csv')}])assert.throws(()=>game.attachment(f));
});
test('Python計算→公開情報調査→戦略提案を実行し、検索には非公開データを渡さず、一時資源を削除する',async()=>{
  const before={...process.env};try{setup();const {calls,transport}=provider();const result=await game.answer(ready(),transport);
    assert.equal(result.complete,true);assert.match(result.text,/次の10配信/);assert.equal(result.usage.input_tokens,30);assert.equal(result.usage.output_tokens,15);assert.equal(result.searches,1);assert.equal(result.usd,null);
    const container=calls.find(x=>x.url.endsWith('/containers'));assert.equal(container.body.memory_limit,'1g');assert.equal(container.body.network_policy.type,'disabled');
    const uploads=calls.filter(x=>x.body instanceof FormData);assert.equal(uploads.length,3);assert.equal(uploads[0].body.get('purpose'),'user_data');assert.equal(uploads[0].body.get('expires_after[seconds]'),'3600');
    const responses=calls.filter(x=>x.url.endsWith('/responses'));assert.equal(responses[0].body.tools[0].type,'code_interpreter');assert.equal(responses[0].body.tool_choice,'required');assert.equal(responses[0].body.text.format.type,'json_schema');
    assert.match(responses[0].body.input[0].content,/\/mnt\/data\/random-prefix-analytics-3.csv/);
    assert.equal(responses[1].body.tools[0].type,'web_search');assert.doesNotMatch(JSON.stringify(responses[1].body),/PRIVATE_CONVERSATION_SENTINEL|Metric1|計算結果/);
    assert.equal(responses[2].body.tools,undefined);assert.match(JSON.stringify(responses[2].body),/Python計算結果/);assert.equal(responses[2].body.max_output_tokens,10000);
    assert.match(responses[2].body.instructions,/今回の確定モードは②/);assert.match(responses[1].body.instructions,/ゲーム市場そのものを必ず検索/);
    assert.equal(calls.filter(x=>x.options.method==='DELETE').length,4);assert.equal(result.citations[0].url,'https://example.com/game-release');
  }finally{process.env=before;}
});
test('CSVの意味が不明なら質問で止まり、市場調査へ進まない',async()=>{
  const before={...process.env};try{setup();const {calls,transport}=provider({auditReady:false});const result=await game.answer(ready('①'),transport);assert.equal(result.complete,true);assert.match(result.text,/対象期間/);assert.equal(calls.filter(x=>x.url.endsWith('/responses')).length,1);assert.equal(calls.filter(x=>x.options.method==='DELETE').length,4);}finally{process.env=before;}
});
test('探索モードでチャンネル詳細形式の回答が返ったら成功扱いしない',async()=>{
  const before={...process.env},oldError=console.error;console.error=()=>{};
  try{setup();const {transport}=provider({wrongMode:true});const result=await game.answer([...ready('①'),{role:'user',text:'②'}],transport);assert.equal(result.complete,false);assert.equal(result.diagnostic.stage,'strategy_answer');assert.equal(result.diagnostic.code,'ANSWER_MODE_MISMATCH');assert.equal(result.usageKnown,true);}
  finally{console.error=oldError;process.env=before;}
});
test('計算未実行・検索未実行・途中の接続障害を完成扱いせず、再試行せずに片付ける',async()=>{
  const before={...process.env};try{setup();for(const options of [{code:false},{search:false},{failStage:2}]){const {calls,transport}=provider(options);const result=await game.answer(ready(),transport);assert.equal(result.complete,false);assert.equal(result.usd,null);assert.equal(calls.filter(x=>x.options.method==='DELETE').length,4);assert.ok(calls.filter(x=>x.url.endsWith('/responses')).length<=2);if(options.failStage)assert.equal(result.usageKnown,false);}}finally{process.env=before;}
});
test('専用カード・ゲームをする女性VTuberサムネイル・CSV相談ページを用意する',()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');assert.match(read('views/tools.html'),/href="\/tools\/youtube-game-strategy"/);assert.match(read('views/youtube-game-strategy.html'),/data-tool="youtube-game-strategy"/);assert.match(read('views/youtube-game-strategy.html'),/Shift-JIS/);
  assert.equal(fs.readFileSync(path.join(__dirname,'../public/images/tools/youtube-game-strategy.webp')).toString('ascii',8,12),'WEBP');
});
test('処理段階とHTTPコードを記録し、APIエラー本文・秘密・CSV内容はログや画面へ出さない',async()=>{
  const before={...process.env},oldError=console.error,logs=[];console.error=(...args)=>logs.push(args);
  try{setup();const result=await game.answer(ready(),async()=>({ok:false,status:400,json:async()=>({error:{type:'invalid_request_error',code:'PRIVATE_SECRET',message:'PRIVATE_SECRET private CSV value'}})}));
    assert.deepEqual(result.diagnostic,{stage:'container_create',code:'PROVIDER_ERROR',httpStatus:400,providerCode:'invalid_request_error'});
    assert.equal(result.complete,false);assert.equal(result.usageKnown,false);assert.doesNotMatch(JSON.stringify([result,logs]),/PRIVATE_SECRET|PRIVATE_CONVERSATION_SENTINEL|Metric1/);assert.equal(logs.length,1);
  }finally{console.error=oldError;process.env=before;}
});
test('隔離DB：指定の初回文・段階送信・履歴分離・本人制御・重複送信・集計・削除',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database');const old={query:db.query,connect:db.pool.connect,answer:game.answer,env:{...process.env}};let server;
  db.query=(s,p)=>s.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(s,p);db.pool.connect=async()=>({query:db.query,release(){}});
  // This fixture covers tool ownership/quotas; FX and shared budgets have dedicated suites.
  try{setup();Object.assign(process.env,{TOOLS_FX_AUTO_ENABLED:'false',TOOLS_USD_TO_JPY:'150',TOOLS_DAILY_BUDGET_JPY:'off',JWT_SECRET:'isolated-game',PAYMENT_ACCESS_CONTROL_ENABLED:'false'});await require('../src/models/schema').createTables();
    const User=require('../src/models/User'),a=await User.create('game-a','dummy','A'),b=await User.create('game-b','dummy','B'),admin=await User.create('game-admin','dummy','管理者','管理者');
    const express=require('express'),jwt=require('jsonwebtoken'),router=require('../src/routes/tools'),app=express();app.use(express.json());for(const key of ['youtube-game-strategy','youtube-analyst','kanau','streaming-gear','vtube-studio'])app.use('/api/tools/'+key,router.createToolRouter(key));app.use('/api/tools',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(p,u=a,method='GET',body)=>fetch(base+p,{method,headers:u?{Authorization:'Bearer '+jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET)}:{},body});
    const thread=await(await req('/youtube-game-strategy/threads',a,'POST')).json(),detail=await(await req('/youtube-game-strategy/threads/'+thread.id)).json();assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].text,game.INTRO);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_usage')).rows[0].n),0);
    for(const key of ['','/youtube-analyst','/kanau','/streaming-gear','/vtube-studio'])assert.equal((await req(key+'/threads/'+thread.id)).status,404);assert.equal((await req('/youtube-game-strategy/threads/'+thread.id,b)).status,404);
    const form=(text,files=[],id=randomUUID())=>{const f=new FormData();f.set('text',text);f.set('requestId',id);for(const [i,c] of files.entries())f.append('attachments',new Blob([c.data]),'name'+i+'.csv');return f;};
    const initialFiles=await(await req('/youtube-game-strategy/threads',a,'POST')).json();
    assert.equal((await req('/youtube-game-strategy/threads/'+initialFiles.id+'/messages',a,'POST',form('https://youtube.com/@test',[csv(1),csv(2),csv(3)]))).status,200);
    const initialDetail=await(await req('/youtube-game-strategy/threads/'+initialFiles.id)).json();assert.equal(initialDetail.messages.at(-1).text,game.INTRO);assert.equal((await req('/youtube-game-strategy/threads/'+initialFiles.id,a,'DELETE')).status,200);
    assert.equal((await req('/youtube-game-strategy/threads/'+thread.id+'/messages',a,'POST',form('①'))).status,200);
    assert.equal((await req('/youtube-game-strategy/threads/'+thread.id+'/messages',a,'POST',form('https://youtube.com/@test',[csv(1),csv(2)]))).status,200);
    const incomplete=await(await req('/youtube-game-strategy/threads/'+thread.id)).json();assert.match(incomplete.messages.at(-1).text,/CSV 2\/3/);
    const {transport}=provider();let calls=0;game.answer=async messages=>{calls++;assert.equal(game.intake(messages).files.length,3);return old.answer(messages,transport);};const rid=randomUUID();
    assert.equal((await req('/youtube-game-strategy/threads/'+thread.id+'/messages',a,'POST',form('追加',[csv(3)],rid))).status,200);
    assert.equal((await req('/youtube-game-strategy/threads/'+thread.id+'/messages',a,'POST',form('追加',[csv(3)],rid))).status,409);assert.equal(calls,1);
    const done=await(await req('/youtube-game-strategy/threads/'+thread.id)).json(),attachment=done.messages.find(m=>m.attachments.length).attachments[0];assert.equal((await req('/youtube-game-strategy/attachments/'+attachment.id,b)).status,404);assert.equal((await req('/youtube-analyst/attachments/'+attachment.id)).status,404);
    assert.equal((await req('/youtube-game-strategy/usage')).status,403);const rows=(await(await req('/usage',admin)).json()).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.tool_key==='youtube-game-strategy'));assert.equal(rows.find(r=>r.model==='local-intake').estimated_usd,'0.00000000');assert.equal(Number(rows.find(r=>r.model==='test-model').input_tokens),30);
    assert.equal((await req('/youtube-game-strategy/threads/'+thread.id,a,'DELETE')).status,200);assert.equal((await req('/youtube-game-strategy/attachments/'+attachment.id)).status,404);assert.equal(Number((await pg.query('SELECT count(*) AS n FROM tool_attachments')).rows[0].n),0);
  }finally{db.query=old.query;db.pool.connect=old.connect;game.answer=old.answer;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});

test('本分析の計算・検索・提案トークンとコンテナ料金を概算する',async()=>{const before={...process.env};try{setup();Object.assign(process.env,{TOOLS_INPUT_USD_PER_MILLION:'0.75',TOOLS_CACHED_USD_PER_MILLION:'0.075',TOOLS_OUTPUT_USD_PER_MILLION:'4.5',TOOLS_SEARCH_USD_PER_CALL:'0.01',TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER:'0.03'});const {transport}=provider();const result=await game.answer(ready(),transport);assert.equal(result.complete,true);assert.ok(result.usd>0.04);assert.equal(result.costDetails.parts.find(p=>p.name==='container_1gb').quantity,1);}finally{process.env=before;}});
