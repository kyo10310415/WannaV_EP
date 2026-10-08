const test=require('node:test');
const assert=require('node:assert/strict');
const source=require('../src/config/centralDatabase');
const service=require('../src/services/centralStudentSync');

test('中央生徒の変換は既存IDを保持し支払いを持ち込まず重複を拒否する',()=>{
  const row={student_id:'S001',name:'山田',notion_page_id:'abcdef',lesson_start_date:'2026-10-01',x_account_id:'@test',payment_status_current_month:'paid'};
  const mapped=service.mapStudents([row],[{notion_page_id:'abc-def',student_number:'S001',name_furigana:'やまだ'}])[0];
  assert.equal(mapped.notionPageId,'abc-def');assert.equal(mapped.nameFurigana,'やまだ');assert.equal(mapped.xUsername,'test');
  assert.equal(mapped.loginId,'S001');assert.ok(!JSON.stringify(mapped).includes('paid'));
  assert.throws(()=>service.mapStudents([row,row],[]));
  assert.throws(()=>service.mapStudents([row,{...row,student_id:'S002',notion_page_id:'abc-def'}],[]));
  assert.throws(()=>service.mapStudents([row],[{notion_page_id:'abc-def'},{notion_page_id:'other',student_number:'S001'}]));
  assert.equal(service.mapStudents([{student_id:'NEW',name:'新生徒'}],[])[0].notionPageId,'central:NEW');
});

test('中央接続は読み取り専用トランザクション・明示列・接続解放で取得する',async()=>{
  const env={...process.env};Object.assign(process.env,{CENTRAL_STUDENT_SYNC_ENABLED:'true',CENTRAL_DATABASE_URL:'postgres://readonly:placeholder@localhost/central_test',CENTRAL_DATABASE_SSL:'false'});
  const pool=source.getPool(),original=pool.connect,queries=[];let released=0;
  pool.connect=async()=>({query:async sql=>{queries.push(sql);return {rows:[]};},release:()=>released++});
  try {
    await source.snapshot();
    assert.match(queries[0],/REPEATABLE READ READ ONLY/);assert.equal(queries.at(-1),'COMMIT');assert.equal(released,1);
    assert.ok(queries.every(sql=>!/payment|password|SELECT \*/i.test(sql)));
    assert.equal(pool.options.max,2);assert.match(pool.options.options,/read_only=on/);
  } finally {pool.connect=original;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});

test('中央同期はアカウントを保持し担当・予約を更新、失敗時キャッシュを保持する', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),User=require('../src/models/User'),Notion=require('../src/models/NotionStudent');
  const original={query:db.query,connect:db.pool.connect,snapshot:source.snapshot};
  const env={...process.env};db.query=(sql,params)=>pg.query(sql,params);db.pool.connect=async()=>({query:db.query,release(){}});
  process.env.CENTRAL_STUDENT_SYNC_ENABLED='true';process.env.JWT_SECRET='test-central-secret';
  let server;
  try {
    await require('../src/models/schema').createTables();
    await Notion.upsertMany([{notionPageId:'existing-page',studentNumber:'S001',studentName:'生徒',loginId:'S001',contractPlan:'エントリープラン',status:'アクティブ'}]);
    const before=(await db.query("SELECT * FROM users WHERE username='S001'")).rows[0];
    const tutor=await User.create('teacher@example.test','1111','先生','クルー');
    const entries=[{student_id:'S001',name:'更新された生徒',status:'レッスン準備中',contract_plan:'スタンダードプラン',notion_page_id:'existingpage',homeroom_tutor:'先生',lesson_start_date:'2026-10-01',x_account_id:'x_test',youtube_channel_id:'UCtest'},
      {student_id:'S002',name:'新生徒',status:'アクティブ',contract_plan:'エントリープラン'}];
    source.snapshot=async()=>({students:entries,tutors:[{notion_name:'先生',email:'teacher@example.test'}],reservations:[{calendar_event_id:'event1',student_id:'S001',lesson_date:'2026-10-20 13:00:00',lesson_time:'13:00',title:'予約'}]});
    const [first,same]=await Promise.all([service.synchronize(),service.synchronize()]);assert.equal(first,same);assert.equal(first.accountsCreated,1);
    const after=(await db.query('SELECT * FROM users WHERE id=$1',[before.id])).rows[0];
    assert.equal(after.password,before.password);assert.equal(after.id,before.id);
    assert.equal((await db.query('SELECT assigned_tutor_id FROM student_profiles WHERE user_id=$1',[before.id])).rows[0].assigned_tutor_id,tutor.id);
    assert.equal((await db.query("SELECT notion_page_id,status FROM notion_students WHERE student_number='S001'")).rows[0].notion_page_id,'existing-page');
    assert.equal((await service.synchronize()).accountsCreated,0);
    source.snapshot=async()=>{throw new Error('private connection information');};
    await assert.rejects(service.synchronize(),error=>!error.message.includes('private connection'));
    assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM central_reservations')).rows[0].count,1);
    source.snapshot=async()=>({students:[],tutors:[],reservations:[]});
    await assert.rejects(service.synchronize());
    assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM central_reservations')).rows[0].count,1);
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/central',require('../src/routes/central'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    const url=base+'/api/central/reservations?studentId=S001';
    assert.equal((await fetch(url)).status,401);
    const call=role=>fetch(url,{headers:{Authorization:'Bearer '+jwt.sign({id:999,role},process.env.JWT_SECRET)}});
    assert.equal((await call('クルー')).status,403);assert.equal((await call('生徒')).status,403);
    const response=await call('管理者');assert.equal(response.status,200);assert.equal((await response.json()).reservations.length,1);
    const own=await fetch(url,{headers:{Authorization:'Bearer '+jwt.sign({id:tutor.id,role:'クルー'},process.env.JWT_SECRET)}});assert.equal(own.status,200);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    db.query=original.query;db.pool.connect=original.connect;source.snapshot=original.snapshot;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});

test('中央連携有効時は直接Notion cronを停止し、毎時日本時間と起動時に同期する',async()=>{
  const cron=require('node-cron'),scheduler=require('../src/utils/scheduler');
  const old={schedule:cron.schedule,sync:service.synchronize,enabled:process.env.CENTRAL_STUDENT_SYNC_ENABLED};
  const jobs=[];let runs=0;
  cron.schedule=(expression,run,options)=>jobs.push({expression,run,options});
  service.synchronize=async()=>{runs++;};process.env.CENTRAL_STUDENT_SYNC_ENABLED='true';
  try {
    scheduler.scheduleNotionSync();assert.equal(jobs.length,0);
    scheduler.scheduleCentralSync();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runs,1);assert.equal(jobs[0].expression,'0 * * * *');assert.equal(jobs[0].options.timezone,'Asia/Tokyo');
    await jobs[0].run();assert.equal(runs,2);
  } finally {
    cron.schedule=old.schedule;service.synchronize=old.sync;
    if(old.enabled===undefined)delete process.env.CENTRAL_STUDENT_SYNC_ENABLED;else process.env.CENTRAL_STUDENT_SYNC_ENABLED=old.enabled;
  }
});
