const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('../src/services/objectStorage');
const sdk = require('@aws-sdk/client-s3');

test('署名URLはprivateなS3 GET、TTLは設定可能で秘密鍵を含まない', async () => {
  const saved = {...process.env};
  try {
    Object.assign(process.env,{ OBJECT_STORAGE_ENABLED:'true',OBJECT_STORAGE_ENDPOINT:'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_BUCKET:'test-bucket',OBJECT_STORAGE_ACCESS_KEY_ID:'test-access',OBJECT_STORAGE_SECRET_ACCESS_KEY:'test-secret',
      MEDIA_SIGNED_URL_TTL_SECONDS:'600' });
    const key = storage.key('video','video-1.mp4');
    assert.equal(storage.validKey(key),true);
    assert.equal(storage.validKey('../escape.mp4'),false);
    const result = await storage.signedGet(key);
    const url = new URL(result.url);
    assert.equal(url.searchParams.get('X-Amz-Expires'),'600');
    assert.match(result.url,/X-Amz-Signature=/);
    assert.ok(!result.url.includes('test-secret'));
    process.env.MEDIA_SIGNED_URL_TTL_SECONDS='bad';
    assert.throws(storage.ttl);
    delete process.env.MEDIA_SIGNED_URL_TTL_SECONDS;
    assert.equal(storage.ttl(),900);
    process.env.OBJECT_STORAGE_ENABLED='false';
    assert.equal(storage.enabled(),false);
    await assert.rejects(storage.signedGet(key),/disabled/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
});

test('アップロード・再生権限・差し替え・削除・移行を隔離DBとSDKモックで確認', {
  skip: !process.env.PGLITE_TEST_MODULE
}, async t => {
  const {PGlite} = require(process.env.PGLITE_TEST_MODULE), pg = new PGlite();
  const db = require('../src/config/database'), Lesson = require('../src/models/Lesson');
  const Progress = require('../src/models/Progress'), Payment = require('../src/models/StudentPayment');
  const thumbnail = require('../src/utils/thumbnail'), media = require('../src/services/lessonMedia');
  const original = {query:db.query,connect:db.pool.connect,send:sdk.S3Client.prototype.send,
    canAccess:Progress.canAccessLesson,payment:Payment.getAccess,thumbnail:thumbnail.generateThumbnail,staging:media.stagingDir};
  const env = {...process.env}, globals = {uploads:global.UPLOAD_DIR,thumbs:global.THUMBS_DIR};
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(),'wannav-object-test-'));
  db.query = (sql,params) => pg.query(sql,params);
  db.pool.connect = async () => ({query:db.query,release(){}});
  global.UPLOAD_DIR=root; global.THUMBS_DIR=path.join(root,'thumbs');
  media.stagingDir=()=>{ const dir=path.join(root,'staging');fs.mkdirSync(dir,{recursive:true});return dir; };
  const objects = new Map(), commands=[];
  let failUpload=false, allowed=true, paid=true;
  sdk.S3Client.prototype.send = async function(command) {
    commands.push(command);
    const input=command.input;
    if (command instanceof sdk.PutObjectCommand) {
      if (failUpload) throw new Error('simulated upload failure');
      objects.set(input.Key,input.ContentLength);
      return {};
    }
    if (command instanceof sdk.HeadObjectCommand) {
      if (!objects.has(input.Key)) throw new Error('missing');
      return {ContentLength:objects.get(input.Key)};
    }
    if (command instanceof sdk.DeleteObjectCommand) {objects.delete(input.Key); return {};}
    if (command instanceof sdk.GetObjectCommand) return {Body:require('stream').Readable.from(['mock-video'])};
    throw new Error('Unexpected SDK request');
  };
  Progress.canAccessLesson=async()=>allowed;
  Payment.getAccess=async()=>({allowed:paid});
  thumbnail.generateThumbnail=async()=>'/uploads/thumbs/mock.jpg';
  Object.assign(process.env,{JWT_SECRET:'object-test-secret',PORTAL_PAYMENT_ENFORCEMENT:'false',
    PAYMENT_ACCESS_CONTROL_ENABLED:'false',OBJECT_STORAGE_ENABLED:'false',OBJECT_STORAGE_ENDPOINT:'https://account.r2.cloudflarestorage.com',
    OBJECT_STORAGE_BUCKET:'test',OBJECT_STORAGE_ACCESS_KEY_ID:'test-access',OBJECT_STORAGE_SECRET_ACCESS_KEY:'test-secret'});
  let server;
  try {
    await require('../src/models/schema').createTables();
    await require('../src/models/schema').createTables();
    await db.query("INSERT INTO courses(id,title,order_index) VALUES (1,'test',0)");
    const express=require('express'), jwt=require('jsonwebtoken');
    const app=express(); app.use(express.json());
    app.use('/api/admin',require('../src/routes/admin'));
    app.use('/api/lessons',require('../src/routes/lessons'));
    app.use('/uploads',require('../src/middleware/objectMediaRedirect'),express.static(root));
    server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const call=(url,role='管理者',method='GET',body)=>fetch(base+url,{method,headers:{Authorization:'Bearer '+jwt.sign({id:1,role},process.env.JWT_SECRET)},...(body?{body}:{})});
    const form=(mode='video-file',name='test.mp4')=>{
      const data=new FormData();
      for(const [key,value] of Object.entries({courseId:'1',title:'test',description:'test',duration:'1',orderIndex:'0',contentMode:mode}))data.append(key,value);
      if(mode==='video-file')data.append('video',new Blob(['test-video'],{type:'video/mp4'}),name);
      if(mode==='video-url')data.append('externalVideoUrl','https://www.youtube.com/watch?v=example');
      if(mode==='image')data.append('image',new Blob(['image'],{type:'image/jpeg'}),'test.jpg');
      return data;
    };
    let legacy, uploaded;
    await t.test('無効時は既存ローカル動画を保存し、有効時はObjectへ保存して一時ファイルを削除',async()=>{
      let response=await call('/api/admin/lessons','管理者','POST',form());
      assert.equal(response.status,201); legacy=await response.json();
      assert.match(legacy.video_url,/^\/uploads\/video-/);
      assert.ok(fs.existsSync(path.join(root,legacy.video_filename)));
      assert.equal(commands.length,0);
      process.env.OBJECT_STORAGE_ENABLED='true';
      response=await call('/api/admin/lessons','管理者','POST',form());
      assert.equal(response.status,201); uploaded=await response.json();
      assert.ok(uploaded.video_storage_key); assert.equal(uploaded.video_url,null);
      assert.ok(objects.has(uploaded.video_storage_key));
      assert.ok(!fs.existsSync(path.join(media.stagingDir(),uploaded.video_filename)));
      assert.equal(uploaded.thumbnail_url,'/uploads/thumbs/mock.jpg');
    });
    await t.test('署名URLは未認証・ロック・未払いでは発行せず管理者と許可生徒には発行',async()=>{
      const url='/api/lessons/'+uploaded.id+'/media-url';
      assert.equal((await fetch(base+url)).status,401);
      const expired=jwt.sign({id:1,role:'管理者'},process.env.JWT_SECRET,{expiresIn:-1});
      const denied=await fetch(base+url,{headers:{Authorization:'Bearer '+expired}});
      assert.equal(denied.status,401);assert.equal((await denied.json()).code,'TOKEN_EXPIRED');
      allowed=false; assert.equal((await call(url,'生徒')).status,403);
      assert.equal((await call(url)).status,200);
      allowed=true;
      const response=await call(url,'生徒'); assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal((await response.json()).storage,'object');
      process.env.PAYMENT_ACCESS_CONTROL_ENABLED='true';paid=false;
      assert.equal((await call(url,'生徒')).status,403);
      paid=true;process.env.PAYMENT_ACCESS_CONTROL_ENABLED='false';
      const local=await (await call('/api/lessons/'+legacy.id+'/media-url')).json();
      assert.equal(local.url,legacy.video_url);
      assert.equal((await call(url+'?kind=image')).status,400);
      process.env.OBJECT_STORAGE_ENABLED='false';
      assert.equal((await call(url)).status,503);
      process.env.OBJECT_STORAGE_ENABLED='true';
    });
    await t.test('外部動画と画像教材を保持し画像はprivateなObjectから取得',async()=>{
      const external=await (await call('/api/admin/lessons','管理者','POST',form('video-url'))).json();
      assert.equal(external.video_storage_key,null);
      const data=await (await call('/api/lessons/'+external.id+'/media-url')).json();
      assert.equal(data.storage,'external'); assert.match(data.url,/youtube/);
      const response=await call('/api/admin/lessons','管理者','POST',form('image'));
      assert.equal(response.status,201);const image=await response.json();
      assert.ok(image.image_storage_key); assert.equal(image.image_url,null);
      assert.equal((await (await call('/api/lessons/'+image.id+'/media-url?kind=image')).json()).storage,'object');
      const animated=path.join(root,'animated.png');await fs.promises.writeFile(animated,'PNG acTL animation');
      const source={path:animated,filename:'animated.png',size:18};
      assert.equal((await media.optimizeImage(source)).path,animated);
      const responseThumb=await call('/api/admin/lessons/'+uploaded.id+'/regenerate-thumbnail','管理者','POST');
      assert.equal(responseThumb.status,200);
      assert.ok(commands.some(cmd=>cmd instanceof sdk.GetObjectCommand));
    });
    await t.test('アップロード失敗・DB失敗では旧Objectを残し、新Objectだけを片付ける',async()=>{
      const before=uploaded.video_storage_key;
      failUpload=true;
      assert.equal((await call('/api/admin/lessons/'+uploaded.id,'管理者','PATCH',form())).status,500);
      assert.equal((await Lesson.findById(uploaded.id)).video_storage_key,before);
      assert.ok(objects.has(before));failUpload=false;
      const update=Lesson.update;Lesson.update=async()=>{throw new Error('DB failed');};
      const count=objects.size;
      try {assert.equal((await call('/api/admin/lessons/'+uploaded.id,'管理者','PATCH',form())).status,500);}
      finally {Lesson.update=update;}
      assert.equal(objects.size,count);assert.ok(objects.has(before));
    });
    await t.test('差し替えはDB成功後に旧Objectを削除、レッスン削除失敗ではObjectを残す',async()=>{
      const before=uploaded.video_storage_key;
      const response=await call('/api/admin/lessons/'+uploaded.id,'管理者','PATCH',form());
      assert.equal(response.status,200);uploaded=await response.json();
      assert.notEqual(uploaded.video_storage_key,before); assert.ok(!objects.has(before));
      const del=Lesson.delete;Lesson.delete=async()=>{throw new Error('DB failed');};
      try {assert.equal((await call('/api/admin/lessons/'+uploaded.id,'管理者','DELETE')).status,500);}
      finally {Lesson.delete=del;}
      assert.ok(objects.has(uploaded.video_storage_key));
      assert.equal((await call('/api/admin/lessons/'+uploaded.id,'管理者','DELETE')).status,200);
      assert.ok(!objects.has(uploaded.video_storage_key));
    });
    await t.test('migration dry-runは無変更、再実行はskip、既存動画はデフォルトで残す',async()=>{
      const {migrate,localFile}=require('../scripts/migrate-media-to-object-storage');
      const count=commands.length;
      await migrate({root,log(){}});assert.equal(commands.length,count);
      assert.equal((await Lesson.findById(legacy.id)).video_storage_key,null);
      const result=await migrate({root,apply:true,log(){}});assert.equal(result.migrated,1);
      assert.ok(fs.existsSync(path.join(root,legacy.video_filename)));
      assert.equal((await migrate({root,apply:true,log(){}})).migrated,0);
      const migrated=await Lesson.findById(legacy.id);
      assert.equal((await media.mediaUrl(migrated,'video')).storage,'object');
      assert.equal((await fetch(base+legacy.video_url)).status,401);
      const token=jwt.sign({id:1,role:'生徒'},process.env.JWT_SECRET);
      allowed=false;
      assert.equal((await fetch(base+legacy.video_url,{headers:{Cookie:'portal_media='+token},redirect:'manual'})).status,403);
      allowed=true;
      const redirect=await fetch(base+legacy.video_url,{headers:{Cookie:'portal_media='+token,Range:'bytes=0-10'},redirect:'manual'});
      assert.equal(redirect.status,302);assert.match(redirect.headers.get('location'),/r2.cloudflarestorage.com/);
      process.env.OBJECT_STORAGE_ENABLED='false';
      assert.equal((await media.mediaUrl(migrated,'video')).url,legacy.video_url);
      process.env.OBJECT_STORAGE_ENABLED='true';
      await assert.rejects(localFile(root,'../escape.mp4'));
      await assert.rejects(migrate({root,deleteLocal:true,log(){}}));
      failUpload=true;
      const filename='video-fail.mp4';await fs.promises.writeFile(path.join(root,filename),'fail');
      const fail=await Lesson.create({courseId:1,title:'fail',contentType:'video',videoFilename:filename,videoUrl:'/uploads/'+filename,orderIndex:2});
      assert.equal((await migrate({root,apply:true,log(){}})).failed,1);
      assert.equal((await Lesson.findById(fail.id)).video_storage_key,null);
      assert.ok(fs.existsSync(path.join(root,filename)));
      failUpload=false;
      const deletion=await migrate({root,apply:true,deleteLocal:true,log(){}});
      assert.equal(deletion.deleted,2);
      assert.ok(!fs.existsSync(path.join(root,legacy.video_filename)));
      assert.ok(!fs.existsSync(path.join(root,filename)));
    });
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    db.query=original.query;db.pool.connect=original.connect;sdk.S3Client.prototype.send=original.send;
    Progress.canAccessLesson=original.canAccess;Payment.getAccess=original.payment;thumbnail.generateThumbnail=original.thumbnail;
    media.stagingDir=original.staging;
    global.UPLOAD_DIR=globals.uploads;global.THUMBS_DIR=globals.thumbs;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
    await pg.close();
    // This is exclusively the unique test-owned directory created above.
    if(path.dirname(root)===os.tmpdir() && path.basename(root).startsWith('wannav-object-test-'))await fs.promises.rm(root,{recursive:true});
  }
});
