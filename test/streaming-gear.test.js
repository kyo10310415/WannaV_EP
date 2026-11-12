const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path'),vm=require('vm');
const obs=require('../src/services/obsMaster'),gear=require('../src/services/streamingGearConcierge');
test('機材専用の短い比較回答・最大3質問・最新価格確認の指示を既存APIに渡す',async()=>{
  const env={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
    await gear.answer([{role:'user',text:'予算5万円でマイクを選びたい'}],async(_url,options)=>{
      const body=JSON.parse(options.body);assert.equal(body.instructions,gear.PROMPT);assert.notEqual(body.instructions,obs.PROMPT);
      for(const term of ['## 結論','## 1. 必要スペック','## 2. 商品候補','## 3. 追加ヒアリング','3〜5個','最大3つ','要確認','Web検索','追加購入不要'])assert.ok(body.instructions.includes(term));
      assert.equal(body.store,false);assert.equal(body.tool_choice,'required');assert.equal(body.model,'test-model');
      return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:3,output_tokens:3},output:[{type:'message',content:[{type:'output_text',text:'機材回答'}]}]})};
    });
  }finally{process.env=env;}
});
test('機材の表・見出し・リンクを安全なDOMで表示しHTMLや危険なURLを実行しない',()=>{
  function node(tag,text=''){return {tag,textContent:text,children:[],attributes:{},append(...xs){this.children.push(...xs);},setAttribute(k,v){this.attributes[k]=v;}};}
  const context={window:{},URL,document:{createElement:tag=>node(tag),createTextNode:text=>node('#text',text)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tool-markdown.js'),'utf8'),context);
  const root=context.window.ToolMarkdown.render('## 2. 商品候補\n| 優先度 | 商品 | URL |\n|---|---|---|\n|1|**商品A**|[公式](https://example.com/a)|\n<script>alert(1)</script>\n[危険](javascript:alert(1))\n[秘密](https://user:pass@example.com)');
  const all=[];function walk(n){all.push(n);n.children.forEach(walk);}walk(root);
  assert.equal(all.filter(n=>n.tag==='table').length,1);assert.equal(all.filter(n=>n.tag==='h3').length,1);assert.equal(all.filter(n=>n.tag==='th').length,3);
  const links=all.filter(n=>n.tag==='a');assert.equal(links.length,1);assert.equal(links[0].href,'https://example.com/a');assert.equal(links[0].rel,'noopener noreferrer');
  assert.equal(all.some(n=>n.tag==='script'),false);assert.ok(all.some(n=>n.textContent.includes('<script>')));
  const code=fs.readFileSync(path.join(__dirname,'../public/js/tool-markdown.js'),'utf8');assert.doesNotMatch(code,/innerHTML|insertAdjacentHTML|eval\(/);
});
test('機材カード・サムネイル・専用相談画面と比較表スタイルを用意する',()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');assert.match(read('views/tools.html'),/href="\/tools\/streaming-gear"/);
  const html=read('views/streaming-gear.html');assert.match(html,/data-tool="streaming-gear"/);assert.match(html,/src="\/js\/tool-markdown.js"/);assert.match(html,/href="\/tools"/);
  assert.match(read('views/obs-master.html'),/tool-markdown.js/);assert.match(read('views/vtube-studio-master.html'),/tool-markdown.js/);
  const img=fs.readFileSync(path.join(__dirname,'../public/images/tools/streaming-gear-concierge.webp'));assert.equal(img.toString('ascii',8,12),'WEBP');
});
test('3ツールの本人履歴・添付を混在させず、機材回答と使用量を正しく記録する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database'),vts=require('../src/services/vtubeStudioMaster');
  const old={query:db.query,connect:db.pool.connect,gear:gear.answer,obs:obs.answer,vts:vts.answer,env:{...process.env}};let server;
  db.query=(s,p)=>s.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(s,p);db.pool.connect=async()=>({query:db.query,release(){}});
  // This fixture covers tool ownership/quotas; FX and shared budgets have dedicated suites.
  try{Object.assign(process.env,{TOOLS_FX_AUTO_ENABLED:'false',TOOLS_USD_TO_JPY:'150',TOOLS_DAILY_BUDGET_JPY:'off',JWT_SECRET:'isolated-gear',PAYMENT_ACCESS_CONTROL_ENABLED:'false',OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model'});
    await require('../src/models/schema').createTables();const User=require('../src/models/User'),a=await User.create('gear-a','dummy','生徒A'),b=await User.create('gear-b','dummy','生徒B'),admin=await User.create('gear-admin','dummy','管理者','管理者');
    const express=require('express'),jwt=require('jsonwebtoken'),router=require('../src/routes/tools'),app=express();app.use(express.json());
    for(const key of ['vtube-studio','streaming-gear'])app.use('/api/tools/'+key,router.createToolRouter(key));app.use('/api/tools',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/tools';
    const req=(key,p,u=a,method='GET',body)=>fetch(base+(key==='obs-master'?'':'/'+key)+p,{method,headers:u?{Authorization:'Bearer '+jwt.sign({id:u.id,role:u.role},process.env.JWT_SECRET)}:{},body});
    const keys=['obs-master','vtube-studio','streaming-gear'],threads={};for(const key of keys)threads[key]=(await(await req(key,'/threads',a,'POST')).json()).id;
    const form=()=>{const f=new FormData();f.set('text','機材を選びたい');f.set('requestId',randomUUID());f.append('attachments',new Blob(['my gear log']),'gear.log');return f;};
    for(const key of keys){assert.deepEqual((await(await req(key,'/threads')).json()).map(x=>x.id),[threads[key]]);
      for(const other of keys.filter(x=>x!==key))for(const method of ['GET','DELETE','POST'])assert.equal((await req(key,'/threads/'+threads[other]+(method==='POST'?'/messages':''),a,method,method==='POST'?form():undefined)).status,404);}
    let calls=0;obs.answer=vts.answer=async()=>{throw new Error('wrong tool');};gear.answer=async m=>{calls++;assert.equal(m.length,1);return {complete:true,text:'## 結論\n機材回答',citations:[],usage:{input_tokens:40,output_tokens:15},searches:1,model:'test-model',usd:.02};};
    assert.equal((await req('streaming-gear','/threads/'+threads['streaming-gear']+'/messages',a,'POST',form())).status,200);assert.equal(calls,1);
    const detail=await(await req('streaming-gear','/threads/'+threads['streaming-gear'])).json(),attachment=detail.messages.find(m=>m.role==='user').attachments[0].id;
    assert.equal((await req('streaming-gear','/threads/'+threads['streaming-gear'],b)).status,404);
    for(const key of ['obs-master','vtube-studio'])assert.equal((await req(key,'/attachments/'+attachment)).status,404);
    assert.equal(await(await req('streaming-gear','/attachments/'+attachment)).text(),'my gear log');
    const report=await(await req('obs-master','/usage',admin)).json();assert.equal(report.rows[0].tool_key,'streaming-gear');assert.equal(Number(report.rows[0].estimated_usd),.02);assert.equal((await req('streaming-gear','/usage',a)).status,403);
    for(let i=0;i<29;i++)await pg.query("INSERT INTO tool_usage(id,user_id,tool_key,status) VALUES($1,$2,$3,'unknown')",[randomUUID(),a.id,keys[i%3]]);
    for(const key of keys)assert.equal((await req(key,'/threads/'+threads[key]+'/messages',a,'POST',form())).status,429);assert.equal(calls,1);
    assert.equal((await req('streaming-gear','/threads/'+threads['streaming-gear'],a,'DELETE')).status,200);assert.equal((await req('streaming-gear','/attachments/'+attachment)).status,404);
    for(const key of ['obs-master','vtube-studio'])assert.equal((await req(key,'/threads/'+threads[key])).status,200);
  }finally{db.query=old.query;db.pool.connect=old.connect;gear.answer=old.gear;obs.answer=old.obs;vts.answer=old.vts;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
