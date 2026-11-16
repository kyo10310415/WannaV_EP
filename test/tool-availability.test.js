const test=require('node:test'),assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
const tick=()=>new Promise(setImmediate);
async function setup(configs,{failHistory=false,holdGeneration=false,generationFails=false,failAuth=false,failStorage=false,cryptoApi,formDataType}={}){
 const nodes={},calls=[],intervals=[],events={},queue=[...configs];let time=0,releaseGeneration;const generation=new Promise(resolve=>releaseGeneration=resolve);
 const node=()=>({children:[],textContent:'',value:'',files:[],hidden:false,disabled:false,append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}}),get=id=>nodes[id]||(nodes[id]=node());
 const context={document:{body:{dataset:{tool:'kanau'}},hidden:false,getElementById:get,createElement:node,addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:()=> 'token'},location:{},FormData,Date:{now:()=>time},crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000001'},setInterval:fn=>intervals.push(fn),confirm:()=>true,
 fetch:async(url,options)=>{calls.push({url,options});let data;if(url==='/api/auth/me')data=failAuth?{httpStatus:401,code:'INVALID_TOKEN',error:'認証に失敗しました'}:{role:'生徒'};else if(url.endsWith('/config')){data=queue.length>1?queue.shift():queue[0];if(data instanceof Error)throw data;}else if(url.endsWith('/messages')){if(holdGeneration)await generation;if(generationFails)throw new Error('生成エラー');data={success:true};}else if(url.endsWith('/threads/example'))data={thread:{title:'相談'},messages:[]};else if(url.endsWith('/threads')){if(failHistory)throw new Error('履歴の取得に失敗');data=options.method==='POST'?{id:'example'}:[];}else data={};return {ok:!data.httpStatus,status:data.httpStatus||200,json:async()=>data};}};
 if(cryptoApi!==undefined)context.crypto=cryptoApi;
 if(formDataType)context.FormData=formDataType;
 if(failStorage)context.localStorage.getItem=()=>{throw Error('Storage unavailable');};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tools.js'),'utf8'),context);await tick();return {get,calls,intervals,events,context,releaseGeneration,advance:ms=>time+=ms};
}
test('他の処理中に開いても、自動再確認でボタンが復帰し入力を消さない',async()=>{
 const h=await setup([{enabled:false,unavailableMessage:'回答を処理しています',retryAfterSeconds:15},{enabled:true}]);h.get('tool-text').value='作りたい画像';assert.equal(h.get('send').disabled,true);assert.equal(h.get('tool-availability').hidden,false);assert.match(h.get('tool-availability-message').textContent,/回答を処理/);
 h.advance(16000);h.intervals[0]();await tick();assert.equal(h.get('send').disabled,false);assert.equal(h.get('tool-availability').hidden,true);assert.equal(h.get('tool-text').value,'作りたい画像');assert.match(h.get('tool-status').textContent,/利用できるように/);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});
test('通信失敗には理由と再確認を表示し、手動再確認で回復する',async()=>{
 const h=await setup([new Error('offline'),{enabled:true}]);assert.equal(h.get('send').disabled,true);assert.match(h.get('tool-availability-message').textContent,/通信状態/);assert.equal(h.get('refresh-availability').disabled,false);
 await h.get('refresh-availability').onclick();assert.equal(h.get('send').disabled,false);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});
test('履歴取得の失敗で、利用可能な送信ボタンを無効のままにしない',async()=>{
 const h=await setup([{enabled:true}],{failHistory:true});assert.equal(h.get('send').disabled,false);assert.match(h.get('tool-status').textContent,/履歴/);
});
test('日次上限とモデル未設定は解除せず、案内を残す。非表示タブでは定期取得しない',async()=>{
 const h=await setup([{enabled:false,unavailableMessage:'現在使用できません。明日以降にお試しください。',retryAfterSeconds:3600}]);h.advance(10000);h.intervals[0]();await tick();assert.equal(h.calls.filter(c=>c.url.endsWith('/config')).length,1);assert.equal(h.get('send').disabled,true);
 h.context.document.hidden=true;h.advance(3600000);h.intervals[0]();await tick();assert.equal(h.calls.filter(c=>c.url.endsWith('/config')).length,1);h.context.document.hidden=false;h.events.visibilitychange();await tick();assert.equal(h.get('send').disabled,true);assert.match(h.get('tool-availability-message').textContent,/明日以降/);
 const unconfigured=await setup([{enabled:false}]);assert.match(unconfigured.get('tool-availability-message').textContent,/準備中/);assert.equal(unconfigured.get('send').disabled,true);
});
test('6画面に読み込み中から見える案内と、フォーム送信しない再確認ボタンがある',()=>{
 for(const name of ['obs-master','vtube-studio-master','streaming-gear','kanau','youtube-analyst','youtube-game-strategy']){const html=fs.readFileSync(path.join(__dirname,'../views/'+name+'.html'),'utf8');assert.match(html,/id="tool-availability"/);assert.match(html,/id="refresh-availability" type="button"/);assert.match(html,/利用状況を確認しています/);}
});

test('画像生成中だけインジケーターを表示し、成功・失敗のどちらでも解除する',async()=>{
 for(const generationFails of [false,true]){
  const h=await setup([{enabled:true}],{holdGeneration:true,generationFails});h.get('tool-text').value='画像を作成';
  const pending=h.get('chat-form').onsubmit({preventDefault(){}});await tick();
  assert.equal(h.get('tool-processing').hidden,false);assert.match(h.get('tool-processing-title').textContent,/画像を生成中/);assert.equal(h.get('send').disabled,true);
  h.releaseGeneration();await pending;assert.equal(h.get('tool-processing').hidden,true);assert.equal(h.get('send').disabled,false);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/messages')).length,1);if(generationFails)assert.match(h.get('tool-status').textContent,/生成エラー/);
 }
});

test('初期確認の403は支払い等の理由と確認コードをボタンの近くに残す',async()=>{
 const h=await setup([{httpStatus:403,code:'PAYMENT_REQUIRED',error:'お支払い状況をご確認ください。'}]);
 assert.equal(h.get('send').disabled,true);assert.match(h.get('tool-action-status').textContent,/お支払い/);assert.match(h.get('tool-action-status').textContent,/CONFIG_403_PAYMENT_REQUIRED/);
 assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});

test('初期ログイン確認失敗の理由を一般的な通信失敗で上書きしない',async()=>{
 const h=await setup([{enabled:true}],{failAuth:true});
 assert.equal(h.get('send').disabled,true);assert.match(h.get('tool-action-status').textContent,/INITIALIZE_401_INVALID_TOKEN/);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/config')).length,0);
});

test('randomUUIDがないブラウザも暗号学的乱数で有効なv4 UUIDを送る',async()=>{
 const h=await setup([{enabled:true}],{cryptoApi:{getRandomValues:bytes=>{for(let i=0;i<bytes.length;i++)bytes[i]=i;return bytes;}}});
 h.get('tool-text').value='画像を作成';await h.get('chat-form').onsubmit({preventDefault(){}});
 const call=h.calls.find(c=>c.url.endsWith('/messages'));assert.ok(call);assert.match(call.options.body.get('requestId'),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(h.get('send').disabled,false);
});

test('ブラウザの送信準備が失敗しても入力を保持し、ボタン・生成表示を復帰する',async()=>{
 for(const options of [{cryptoApi:{}},{formDataType:class{constructor(){throw Error('FormDataの準備に失敗');}}}]){
  const h=await setup([{enabled:true}],options);h.get('tool-text').value='消さない入力';await h.get('chat-form').onsubmit({preventDefault(){}});
  assert.equal(h.get('send').disabled,false);assert.equal(h.get('new-thread').disabled,false);assert.equal(h.get('tool-processing').hidden,true);assert.equal(h.get('tool-text').value,'消さない入力');
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);assert.match(h.get('tool-action-status').textContent,/準備|BROWSER_CRYPTO/);
 }
});

test('ブラウザが保存データを拒否しても無言で停止せず、入力欄の近くに確認コードを出す',async()=>{
 const h=await setup([{enabled:true}],{failStorage:true});assert.match(h.get('tool-action-status').textContent,/BROWSER_STORAGE/);assert.equal(h.calls.length,0);
});
