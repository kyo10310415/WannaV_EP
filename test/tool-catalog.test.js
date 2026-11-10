const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('一覧カードから専用相談ページへ進み、既存チャットJSと履歴APIを維持する',()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
  const catalog=read('views/tools.html'),chat=read('views/obs-master.html'),server=read('server.js');
  assert.match(catalog,/href="\/tools\/obs-master"/);assert.match(catalog,/src="\/images\/tools\/obs-master.webp"/);
  assert.doesNotMatch(catalog,/id="chat-form"|src="\/js\/tools.js"/);assert.match(chat,/id="chat-form"/);assert.match(chat,/src="\/js\/tools.js"/);
  assert.match(chat,/href="\/tools"/);assert.match(server,/app.get\('\/tools\/obs-master'/);
  const image=fs.readFileSync(path.join(__dirname,'../public/images/tools/obs-master.webp'));
  assert.equal(image.toString('ascii',0,4),'RIFF');assert.equal(image.toString('ascii',8,12),'WEBP');
});
test('未ログイン・初回変更・不正権限・取得失敗ではカードを表示しない',async()=>{
  const code=fs.readFileSync(path.join(__dirname,'../public/js/tool-catalog.js'),'utf8');
  async function run(token,user,ok=true){const catalog={hidden:true},status={textContent:''},location={href:'/tools'};let calls=0;
    vm.runInNewContext(code,{localStorage:{getItem:()=>token},window:{location},document:{getElementById:id=>id==='tool-catalog'?catalog:status},
      fetch:async()=>{calls++;return {ok,json:async()=>user};}});
    await new Promise(resolve=>setImmediate(resolve));return {catalog,status,location,calls};}
  const guest=await run(null,{});assert.equal(guest.location.href,'/');assert.equal(guest.calls,0);
  for(const role of ['生徒','管理者','クルー','セールス']) assert.equal((await run('test',{role})).catalog.hidden,false);
  assert.equal((await run('test',{role:'生徒',needsPasswordChange:true})).location.href,'/');
  assert.equal((await run('test',{role:'unknown'})).catalog.hidden,true);
  assert.equal((await run('test',{},false)).catalog.hidden,true);
});
