const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require.resolve('../views/lesson.html'),'utf8');

test('Object動画は描画前に署名URLを取得し、モバイル・metadata preloadを維持する',()=>{
  assert.match(html,/video_storage_key\) currentLesson\.video_url = \(await getMediaUrl\('video'\)\)\.url;[\s\S]*renderLesson\(\)/);
  assert.match(html,/image_storage_key\) currentLesson\.image_url = \(await getMediaUrl\('image'\)\)\.url/);
  assert.match(html,/playsinline preload="metadata"/);
  assert.match(html,/source src="\$\{escHtml\(videoUrl\)\}/);
});

test('期限切れ動画は認証付きでURLを再発行し、再生位置を復元する',async()=>{
  const handlers = new Map(), calls = [];
  const video = { currentTime:75, paused:false, src:'old', load(){}, play:async()=>{},
    addEventListener:(name,fn)=>handlers.set(name,fn) };
  const context={API_URL:'/api',lessonId:1,document:{getElementById:()=>video,addEventListener(){}},
    localStorage:{getItem:()=> 'fake-token'},Date,showAlert:()=>assert.fail('unexpected error'),
    fetch:async (url,options)=>{
      calls.push({url,options});
      return {ok:true,json:async()=>({url:'https://storage.example/private.mp4?signed',expiresAt:new Date(Date.now()+900000).toISOString()})};
    }};
  const getMedia=html.slice(html.indexOf('let mediaExpiresAt = 0;'),html.indexOf('function renderLesson()'));
  const refresh=html.slice(html.indexOf('function attachMediaRefresh()'),html.indexOf('function buildIframe('));
  vm.runInNewContext(getMedia+refresh+'\nmediaExpiresAt = Date.now()-1; attachMediaRefresh();',context);
  handlers.get('play')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/lessons/1/media-url?kind=video');
  assert.equal(calls[0].options.headers.Authorization,'Bearer fake-token');
  assert.equal(video.src,'https://storage.example/private.mp4?signed');
  video.currentTime=0;handlers.get('loadedmetadata')();
  assert.equal(video.currentTime,75);
  handlers.get('seeking')();handlers.get('error')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
});

test('失敗時のURL再取得は2回までで、再生イベントだけではretry枠をリセットしない',async()=>{
  const handlers=new Map(), docHandlers=new Map();let calls=0,now=100000;
  const video={currentTime:50,paused:false,addEventListener:(name,fn)=>handlers.set(name,fn)};
  const context={document:{getElementById:()=>video,visibilityState:'visible',addEventListener:(name,fn)=>docHandlers.set(name,fn)},
    mediaExpiresAt:1,Date:{now:()=>now},getMediaUrl:async()=>{calls++;throw new Error('unavailable');},showAlert(){}};
  const refresh=html.slice(html.indexOf('function attachMediaRefresh()'),html.indexOf('function buildIframe('));
  vm.runInNewContext(refresh+'\nattachMediaRefresh();',context);
  docHandlers.get('visibilitychange')();await new Promise(resolve=>setImmediate(resolve));
  now+=6000;handlers.get('seeking')();await new Promise(resolve=>setImmediate(resolve));
  now+=6000;handlers.get('error')();handlers.get('play')();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);
});
