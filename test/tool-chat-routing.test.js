const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('共通チャットJSはページのツール識別に従って履歴・新規作成・送信先を選ぶ',async()=>{
  for(const key of ['obs-master','vtube-studio','streaming-gear','kanau','youtube-analyst','youtube-game-strategy']) {
    const base=key==='obs-master'?'/api/tools':'/api/tools/'+key,calls=[],nodes={};
    const node=()=>({children:[],value:'',files:[],hidden:true,append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}});
    const get=id=>nodes[id]||(nodes[id]=node());
    const context={document:{body:{dataset:{tool:key}},getElementById:get,createElement:node},localStorage:{getItem:()=> 'test'},location:{},FormData,crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000001'},confirm:()=>true,
      fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/auth/me'?{role:'管理者'}:url===base+'/usage'?{rows:[{unpriced:1,known_usd:'0.05',known_jpy:7.5,image_estimates:1}],notice:'テスト集計',exchangeRate:150,missingPrices:[]}:url===base+'/config'?{enabled:true}:url===base+'/threads'?(options.method==='POST'?{id:'example'}:[]):url===base+'/threads/example'?{thread:{title:'相談'},messages:[]}:{success:true}};}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tools.js'),'utf8'),context);
    await new Promise(resolve=>setImmediate(resolve));assert.ok(calls.some(x=>x.url===base+'/config'));assert.ok(calls.some(x=>x.url===base+'/threads'));
    assert.equal(get('send').disabled,false);
    get('tool-text').value='接続できません';await get('chat-form').onsubmit({preventDefault(){}});
    assert.ok(calls.some(x=>x.url===base+'/threads/example/messages'&&x.options.method==='POST'));
    assert.equal(calls.filter(x=>x.url===base+'/threads'&&x.options.method==='POST').length,1);
    get('tool-text').value='同じ相談の続き';await get('chat-form').onsubmit({preventDefault(){}});
    assert.equal(calls.filter(x=>x.url===base+'/threads'&&x.options.method==='POST').length,1);
    await get('new-thread').onclick();assert.equal(calls.filter(x=>x.url===base+'/threads'&&x.options.method==='POST').length,2);
    if(key==='youtube-analyst')assert.equal(calls.find(x=>x.url===base+'/threads/example/messages').options.body.get('mode'),'analyze');
    await get('usage-button').onclick();const displayed=get('usage-rows').children[0].children.map(n=>n.textContent);assert.ok(displayed.includes('一部未算出：$0.050000'));assert.ok(displayed.includes('一部未算出：¥7.50'));assert.ok(get('usage-notice').textContent.includes('1 USD = 150円'));
    const wrong=key==='obs-master'?'/api/tools/vtube-studio/threads':'/api/tools/threads';assert.equal(calls.some(x=>x.url===wrong),false);
  }
});
