const test=require('node:test'),assert=require('node:assert/strict');
const request=require('../src/services/toolRequest'),obs=require('../src/services/obsMaster'),vts=require('../src/services/vtubeStudioMaster'),gear=require('../src/services/streamingGearConcierge'),analyst=require('../src/services/youtubeAnalyst'),kanau=require('../src/services/kanau');
const image=n=>({kind:'image',name:'reference.webp',mime:'image/webp',data:Buffer.concat([Buffer.from('RIFF0000WEBP'),Buffer.alloc(16000,n)])});
const response=body=>({ok:true,json:async()=>({status:'completed',usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20}},output:body.tools?.[0]?.type==='image_generation'?[{type:'image_generation_call',status:'completed',result:Buffer.from('RIFF0000WEBPfake').toString('base64')}]:[{type:'message',content:[{type:'output_text',text:'回答'}]}]})});
async function configured(fn){const env={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'test-model',OPENAI_KANAU_IMAGE_MODEL:'test-image-model'});await fn();}finally{process.env=env;}}
test('OBS・VTS・機材・YouTube分析は同一の大きな添付だけを1回にし会話は残す',()=>configured(async()=>{
 for(const service of [obs,vts,gear,analyst]){
  const img=image(1),document={kind:service===analyst?'csv':'log',mime:'text/plain',data:Buffer.from('title,value\nrow,1\n'.repeat(1000))};
  const messages=[{role:'user',text:'PRIVATE_START',attachments:[img,document]},{role:'assistant',text:'前の回答'},{role:'user',text:'同じ資料の別の箇所を確認',attachments:[{...img,name:'renamed.webp'},document]}];
  let body;const result=await service.answer(messages,async(_url,o)=>{body=JSON.parse(o.body);return response(body);});
  const parts=body.input.flatMap(m=>Array.isArray(m.content)?m.content:[]);assert.equal(parts.filter(p=>p.type==='input_image').length,1);assert.equal(parts.filter(p=>p.text?.includes('title,value')).length,1);assert.equal(parts.filter(p=>p.text?.includes('添付資料の再掲')).length,2);assert.equal(body.input.length,3);assert.equal(body.input[1].content,'前の回答');assert.equal(result.costDetails.deduplicated_attachments,2);const repeatedBody=JSON.parse(JSON.stringify(body));repeatedBody.input[2].content[1]=body.input[0].content[1];repeatedBody.input[2].content[2]=body.input[0].content[2];assert.ok(Buffer.byteLength(JSON.stringify(body))<Buffer.byteLength(JSON.stringify(repeatedBody))*0.8);
  assert.equal(messages[2].attachments[0].data.length,img.data.length);assert.doesNotMatch(body.prompt_cache_key,/PRIVATE_START/);assert.equal(body.store,false);
  let second;await service.answer([{role:'user',text:'別の相談',attachments:[img]}],async(_url,o)=>{second=JSON.parse(o.body);return response(second);});assert.equal(second.input[0].content[1].type,'input_image');
 }
}));
test('かなうさん・YouTube画像作成は元の立ち絵と異なる生成履歴を残し、再掲だけ省く',()=>configured(async()=>{
 for(const service of [kanau,analyst]){
  const original=image(1),generated={...image(2),kind:'generated'},latest={...image(3),kind:'generated'};
  const messages=[{role:'user',text:'元の立ち絵',attachments:[original]},{role:'assistant',text:'最初の成果物',attachments:[generated]},{role:'user',text:'同じ画像の色だけ修正',attachments:[original,generated]},{role:'assistant',text:'修正版',attachments:[latest]},{role:'user',text:'最初の成果物をもう一度修正',metadata:{mode:'thumbnail',size:'1536x864'},attachments:[generated]}];
  let body;const result=await service.answer(messages,async(_url,o)=>{body=JSON.parse(o.body);return response(body);});const parts=body.input.flatMap(m=>m.content);assert.equal(parts.filter(p=>p.type==='input_image').length,3);assert.equal(parts.filter(p=>p.text?.includes('添付資料の再掲')).length,3);assert.ok(parts.some(p=>p.image_url?.endsWith(original.data.toString('base64'))));assert.ok(parts.some(p=>p.image_url?.endsWith(latest.data.toString('base64'))));assert.equal(body.tools[0].quality,'medium');assert.equal(body.tools[0].model,'test-image-model');assert.equal(body.max_tool_calls,1);assert.equal(result.costDetails.deduplicated_attachments,3);
 }
}));
test('小さい添付・異なる内容・異なる種類を重複として消さない',()=>{
 const tracker=request.attachmentTracker(),small={kind:'log',data:Buffer.from('short')};assert.equal(tracker.reference(small),null);assert.equal(tracker.reference(small),null);assert.equal(tracker.reference(image(1)),null);assert.equal(tracker.reference(image(2)),null);assert.equal(tracker.reference({...image(1),mime:'image/png'}),null);assert.equal(tracker.duplicates,0);
});
test('初回・最新情報・添付ありは検索必須、短い返信は検索可能のまま任意にする',()=>configured(async()=>{
 for(const service of [obs,vts,gear]){
  for(const [messages,choice] of [[[{role:'user',text:'1'}],'required'],[[{role:'user',text:'相談'},{role:'assistant',text:'番号を選んでください'},{role:'user',text:'1'}],'auto'],[[{role:'assistant',text:'回答'},{role:'user',text:'ありがとうございます！'}],'auto'],[[{role:'assistant',text:'回答'},{role:'user',text:'最新の価格を調べて'}],'required'],[[{role:'assistant',text:'回答'},{role:'user',text:'1',attachments:[image(1)]}],'required']]){
   await service.answer(messages,async(_url,o)=>{const body=JSON.parse(o.body);assert.equal(body.tool_choice,choice);assert.equal(body.tools[0].type,'web_search');assert.equal(body.max_tool_calls,3);return response(body);});
  }
 }
}));
test('キャッシュ識別子は固定条件に対し安定し、ツール・モデル・画像設定で分かれる',()=>{
 assert.equal(request.cacheKey('m','instructions'),request.cacheKey('m','instructions'));assert.notEqual(request.cacheKey('m','instructions'),request.cacheKey('m2','instructions'));assert.notEqual(request.cacheKey('m','instructions'),request.cacheKey('m','other'));assert.notEqual(request.cacheKey('m','instructions','image:a'),request.cacheKey('m','instructions','image:b'));assert.ok(request.cacheKey('m','i').length<=64);
});
