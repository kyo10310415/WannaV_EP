const test=require('node:test'),assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
const tick=()=>new Promise(setImmediate);
async function setup(configs,{failHistory=false}={}){
 const nodes={},calls=[],intervals=[],events={},queue=[...configs];let time=0;
 const node=()=>({children:[],textContent:'',value:'',files:[],hidden:false,disabled:false,append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}}),get=id=>nodes[id]||(nodes[id]=node());
 const context={document:{body:{dataset:{tool:'kanau'}},hidden:false,getElementById:get,createElement:node,addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:()=> 'token'},location:{},FormData,Date:{now:()=>time},crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000001'},setInterval:fn=>intervals.push(fn),confirm:()=>true,
 fetch:async(url,options)=>{calls.push({url,options});let data;if(url==='/api/auth/me')data={role:'生徒'};else if(url.endsWith('/config')){data=queue.length>1?queue.shift():queue[0];if(data instanceof Error)throw data;}else if(url.endsWith('/threads')){if(failHistory)throw new Error('履歴の取得に失敗');data=[];}else data={};return {ok:true,json:async()=>data};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tools.js'),'utf8'),context);await tick();return {get,calls,intervals,events,context,advance:ms=>time+=ms};
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
