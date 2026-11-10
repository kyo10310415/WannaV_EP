const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('共通チャットJSはページのツール識別に従って履歴・新規作成・送信先を選ぶ',async()=>{
  for(const key of ['obs-master','vtube-studio','streaming-gear','kanau']) {
    const base=key==='obs-master'?'/api/tools':'/api/tools/'+key,calls=[],nodes={};
    const node=()=>({children:[],value:'',files:[],hidden:true,append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}});
    const get=id=>nodes[id]||(nodes[id]=node());
    const context={document:{body:{dataset:{tool:key}},getElementById:get,createElement:node},localStorage:{getItem:()=> 'test'},location:{},FormData,crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000001'},confirm:()=>true,
      fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/auth/me'?{role:'生徒'}:url===base+'/config'?{enabled:true}:url===base+'/threads'?(options.method==='POST'?{id:'example'}:[]):url===base+'/threads/example'?{thread:{title:'相談'},messages:[]}:{success:true}};}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tools.js'),'utf8'),context);
    await new Promise(resolve=>setImmediate(resolve));assert.ok(calls.some(x=>x.url===base+'/config'));assert.ok(calls.some(x=>x.url===base+'/threads'));
    await get('new-thread').onclick();get('tool-text').value='接続できません';await get('chat-form').onsubmit({preventDefault(){}});
    assert.ok(calls.some(x=>x.url===base+'/threads/example/messages'&&x.options.method==='POST'));
    const wrong=key==='obs-master'?'/api/tools/vtube-studio/threads':'/api/tools/threads';assert.equal(calls.some(x=>x.url===wrong),false);
  }
});
