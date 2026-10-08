const test=require('node:test');
const assert=require('node:assert/strict');

test('Notion新規作成は既存情報を保持し、中央反映前も利用可能・反映後は同じアカウントを引き継ぐ', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),Notion=require('../src/models/NotionStudent');
  const api=require('../src/utils/notionSync'),source=require('../src/config/centralDatabase');
  const onboarding=require('../src/services/notionAccountProvision'),central=require('../src/services/centralStudentSync');
  const original={query:db.query,connect:db.pool.connect,fetch:api.fetchTargetPlanStudents,snapshot:source.snapshot};
  const env={...process.env};db.query=(sql,params)=>pg.query(sql,params);db.pool.connect=async()=>({query:db.query,release(){}});
  process.env.CENTRAL_STUDENT_SYNC_ENABLED='true';process.env.JWT_SECRET='isolated-onboarding-key';let server;
  const entry=(id,number,name)=>({notionPageId:id,studentNumber:number,loginId:number,studentName:name,
    status:'アクティブ',contractPlan:'エントリープラン',lessonStartMonth:'2026-10-01',rawData:{properties:{}}});
  try {
    await require('../src/models/schema').createTables();
    await Notion.upsertMany([{...entry('old-page','OLD','中央の生徒'),status:'レッスン準備中',rawData:{source:'central'}}]);
    api.fetchTargetPlanStudents=async()=>[entry('old-page','OLD','Notionの古い氏名'),entry('new-page','NEW','新生徒'),
      entry('duplicate-1','DUP','重複1'),entry('duplicate-2','DUP','重複2')];
    const [first,same]=await Promise.all([onboarding.provision(),onboarding.provision()]);assert.equal(first,same);assert.equal(first.accountsCreated,1);
    const old=(await db.query("SELECT student_name,status FROM notion_students WHERE student_number='OLD'")).rows[0];
    assert.equal(old.student_name,'中央の生徒');assert.equal(old.status,'レッスン準備中');
    const user=(await db.query("SELECT * FROM users WHERE username='NEW'")).rows[0];
    assert.equal(user.password_changed_at,null);assert.ok(await require('../src/models/User').verifyPassword('1111',user.password));
    assert.equal((await onboarding.provision()).accountsCreated,0);
    assert.equal((await db.query("SELECT COUNT(*)::integer AS count FROM users WHERE username='NEW'")).rows[0].count,1);
    source.snapshot=async()=>({students:[{student_id:'OLD',name:'中央の生徒',status:'レッスン準備中',contract_plan:'エントリープラン',notion_page_id:'old-page'}],tutors:[],reservations:[]});
    await central.synchronize();
    let pending=(await db.query("SELECT status,raw_data FROM notion_students WHERE student_number='NEW'")).rows[0];
    assert.equal(pending.status,'アクティブ');assert.equal(pending.raw_data.source,'notion_pending');
    source.snapshot=async()=>({students:[{student_id:'OLD',name:'中央の生徒',status:'レッスン準備中',contract_plan:'エントリープラン',notion_page_id:'old-page'},
      {student_id:'NEW',name:'中央へ反映した新生徒',status:'レッスン準備中',contract_plan:'スタンダードプラン',notion_page_id:'newpage'}],tutors:[],reservations:[]});
    const result=await central.synchronize();assert.equal(result.accountsCreated,0);
    const after=(await db.query("SELECT * FROM users WHERE username='NEW'")).rows[0];
    assert.equal(after.id,user.id);assert.equal(after.password,user.password);
    pending=(await db.query("SELECT status,raw_data,student_name FROM notion_students WHERE student_number='NEW'")).rows[0];
    assert.equal(pending.raw_data.source,'central');assert.equal(pending.status,'レッスン準備中');
    await onboarding.provision();
    assert.equal((await db.query("SELECT student_name FROM notion_students WHERE student_number='NEW'")).rows[0].student_name,'中央へ反映した新生徒');
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/notion',require('../src/routes/notion'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
    const call=role=>fetch('http://127.0.0.1:'+server.address().port+'/api/notion/provision-accounts',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({id:999,role},process.env.JWT_SECRET)}});
    assert.equal((await call('クルー')).status,403);assert.equal((await call('生徒')).status,403);assert.equal((await call('セールス')).status,200);
    process.env.CENTRAL_STUDENT_SYNC_ENABLED='false';assert.equal((await call('管理者')).status,409);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    db.query=original.query;db.pool.connect=original.connect;api.fetchTargetPlanStudents=original.fetch;source.snapshot=original.snapshot;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
