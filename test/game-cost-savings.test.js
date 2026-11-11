const test=require('node:test'),assert=require('node:assert/strict');
const game=require('../src/services/youtubeGameStrategy');
const csv=i=>({kind:'csv',mime:'text/plain',data:Buffer.from('Content,Metric'+i+'\nvideo,'+i)});
const messages=()=>[{role:'user',text:'①',attachments:[]},{role:'user',text:'https://youtube.com/@test PRIVATE_METRICS',attachments:[csv(1),csv(2),csv(3)]}];
function mock(){const calls=[];let ready=true,expired=false,denied=false,container=0,file=0;
 const transport=async(url,options)=>{const body=options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):null;calls.push({url,options,body});const ok=value=>({ok:true,status:200,json:async()=>value});
 if(options.method==='DELETE')return ok({deleted:true});
 if(options.method==='GET')return denied?{ok:false,status:403,json:async()=>({error:{code:'permission_denied'}})}:ok({id:url.split('/').at(-1),status:expired?'expired':'running'});
 if(url.endsWith('/containers'))return ok({id:'cntr_test'+(++container)});
 if(body instanceof FormData)return ok({id:'file-test'+(++file)});
 if(/\/containers\/[^/]+\/files$/.test(url))return ok({path:'/mnt/data/file-'+file+'.csv'});
 const code=body.tools?.[0]?.type==='code_interpreter',search=body.tools?.[0]?.type==='web_search';
 return ok({status:'completed',usage:{input_tokens:10,output_tokens:5},output:[...(code?[{type:'code_interpreter_call',status:'completed'}]:[]),...(search?[{type:'web_search_call'}]:[]),{type:'message',content:[{type:'output_text',text:code?JSON.stringify({ready,question:ready?'':'CSVの意味を確認してください',report:ready?'計算済み数値':''}):search?'公開情報の調査':'1 結論\n新規候補\n最優先テスト\n次の10配信',annotations:search?[{type:'url_citation',url:'https://example.com/official',title:'公式'}]:[]}]}]});};
 return {calls,transport,set ready(v){ready=v},set expired(v){expired=v},set denied(v){denied=v}};
}
async function run(fn){const env={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test',TOOLS_INPUT_USD_PER_MILLION:'0.75',TOOLS_CACHED_USD_PER_MILLION:'0.075',TOOLS_OUTPUT_USD_PER_MILLION:'4.5',TOOLS_SEARCH_USD_PER_CALL:'0.01',TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER:'0.03'});let saved,time=Date.parse('2026-11-11T01:00:00Z');const p=mock(),options=()=>({session:saved,saveSession:async value=>{saved=JSON.parse(JSON.stringify(value));},now:()=>time});await fn({p,options,get saved(){return saved},advance(ms){time+=ms}});}finally{process.env=env;}}
const count=(p,part)=>p.calls.filter(c=>c.url.endsWith(part)&&c.options.method==='POST').length;
test('確認質問の次の返信で同じコンテナ・CSVを再利用し、0.03ドルを二重加算しない',()=>run(async ctx=>{
 ctx.p.ready=false;const first=await game.answer(messages(),ctx.p.transport,ctx.options());assert.equal(first.complete,true);assert.equal(count(ctx.p,'/containers'),1);assert.equal(ctx.saved.fileIds.length,3);assert.equal(ctx.p.calls.filter(c=>c.options.method==='DELETE').length,0);
 ctx.p.ready=true;const next=await game.answer([...messages(),{role:'user',text:'動画別が主表、日別と合計が照合用です'}],ctx.p.transport,ctx.options());assert.equal(next.complete,true);assert.equal(count(ctx.p,'/containers'),1);assert.equal(ctx.p.calls.filter(c=>c.body instanceof FormData).length,3);assert.equal(next.costDetails.reused_container,true);assert.ok(!next.costDetails.parts.some(p=>p.name==='container_1gb'));assert.ok(next.usd<first.usd);
}));
test('条件が同じなら計算結果と15分以内の調査を再利用し、回答APIだけ呼ぶ',()=>run(async ctx=>{
 const first=await game.answer(messages(),ctx.p.transport,ctx.options()),before=ctx.p.calls.length;ctx.advance(60000);
 const next=await game.answer([...messages(),{role:'user',text:'①'}],ctx.p.transport,ctx.options());assert.equal(next.complete,true);assert.equal(next.costDetails.reused_audit,true);assert.equal(next.costDetails.reused_research,true);assert.equal(next.usage.input_tokens,10);assert.equal(first.usage.input_tokens,30);assert.equal(next.searches,0);assert.equal(ctx.p.calls.slice(before).length,1);assert.ok(next.usd<first.usd);
}));
test('再計算・最新指定・モード変更・日付と調査期限を無視しない',()=>run(async ctx=>{
 await game.answer(messages(),ctx.p.transport,ctx.options());let next=await game.answer([...messages(),{role:'user',text:'最新情報で再調査してください'}],ctx.p.transport,ctx.options());assert.equal(next.costDetails.reused_audit,false);assert.equal(next.costDetails.reused_research,false);assert.equal(next.searches,1);
 next=await game.answer([...messages(),{role:'user',text:'②'}],ctx.p.transport,ctx.options());assert.equal(next.costDetails.reused_research,false);assert.equal(next.searches,1);
 ctx.advance(16*60000);next=await game.answer([...messages(),{role:'user',text:'②'}],ctx.p.transport,ctx.options());assert.equal(next.costDetails.reused_audit,true);assert.equal(next.costDetails.reused_research,false);assert.equal(next.costDetails.parts.some(p=>p.name==='container_1gb'),false);
 for(const call of ctx.p.calls.filter(c=>c.body?.tools?.[0]?.type==='web_search'))assert.doesNotMatch(JSON.stringify(call.body),/PRIVATE_METRICS|Metric1/);
}));
test('期限切れは作り直し、別データに計算済みキャッシュを使わない',()=>run(async ctx=>{
 await game.answer(messages(),ctx.p.transport,ctx.options());ctx.p.expired=true;
 const next=await game.answer([...messages(),{role:'user',text:'再計算してください'}],ctx.p.transport,ctx.options());assert.equal(next.complete,true);assert.equal(count(ctx.p,'/containers'),2);assert.equal(next.costDetails.parts.find(p=>p.name==='container_1gb').quantity,1);
 const different=messages();different[1].attachments=[csv(4),csv(5),csv(6)];const changed=await game.answer(different,ctx.p.transport,ctx.options());assert.equal(changed.costDetails.reused_audit,false);assert.equal(count(ctx.p,'/containers'),3);
}));
test('参照エラー時に有料処理を自動再試行せず、削除時は専用コンテナとファイルを片付ける',()=>run(async ctx=>{
 await game.answer(messages(),ctx.p.transport,ctx.options());ctx.p.denied=true;const before=count(ctx.p,'/containers'),old=console.error;console.error=()=>{};try{const failure=await game.answer([...messages(),{role:'user',text:'再計算'}],ctx.p.transport,ctx.options());assert.equal(failure.complete,false);assert.equal(count(ctx.p,'/containers'),before);}finally{console.error=old;}
 await game.cleanupSession(ctx.saved,ctx.p.transport);assert.equal(ctx.p.calls.filter(c=>c.options.method==='DELETE').length,4);
}));
test('15分以内でも日本時間の日付が変わったら公開情報を取り直す',()=>run(async ctx=>{
 ctx.advance(Date.parse('2026-11-11T14:59:00Z')-Date.parse('2026-11-11T01:00:00Z'));await game.answer(messages(),ctx.p.transport,ctx.options());ctx.advance(2*60000);
 const next=await game.answer([...messages(),{role:'user',text:'①'}],ctx.p.transport,ctx.options());assert.equal(next.costDetails.reused_audit,true);assert.equal(next.costDetails.reused_research,false);assert.equal(next.searches,1);
}));
test('セッション保存失敗では処理を続けず、新規作成したコンテナを片付ける',()=>run(async ctx=>{
 let saves=0;const error=console.error,warn=console.warn;console.error=()=>{};console.warn=()=>{};
 try{const result=await game.answer(messages(),ctx.p.transport,{saveSession:async()=>{if(++saves>1)throw new Error('database unavailable');}});assert.equal(result.complete,false);assert.equal(count(ctx.p,'/responses'),0);assert.equal(ctx.p.calls.filter(c=>c.options.method==='DELETE').length,1);}finally{console.error=error;console.warn=warn;}
}));
