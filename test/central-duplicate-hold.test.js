const test=require('node:test');
const assert=require('node:assert/strict');
test('重複保留は情報・アカウント・担当・予約を保持し、他の生徒を同期する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),source=require('../src/config/centralDatabase'),service=require('../src/services/centralStudentSync');
  const original={query:db.query,connect:db.pool.connect,snapshot:source.snapshot},env={...process.env};let server;
  db.query=(sql,params)=>pg.query(sql,params);db.pool.connect=async()=>({query:db.query,release(){}});
  process.env.CENTRAL_STUDENT_SYNC_ENABLED='true';process.env.JWT_SECRET='test-only';
  try {
    await require('../src/models/schema').createTables();
    const Notion=require('../src/models/NotionStudent');
    await Notion.upsertMany([{notionPageId:'one',studentNumber:'DUP',studentName:'保留生徒',loginId:'DUP',contractPlan:'エントリープラン',status:'アクティブ'}]);
    await db.query(`INSERT INTO notion_students(notion_page_id,student_number,student_name,status) VALUES('two','dup','重複候補','レッスン準備中')`);
    await pg.exec(`INSERT INTO central_students(student_id,notion_page_id,tutor_name,synced_at) VALUES('DUP','one','旧担当',now());
      INSERT INTO central_reservations(event_id,student_id,lesson_date,title) VALUES('old','DUP','2026-10-10','旧予約')`);
    const before=(await db.query("SELECT * FROM notion_students WHERE LOWER(student_number)='dup' ORDER BY notion_page_id")).rows;
    const users=(await db.query('SELECT * FROM users')).rows,profiles=(await db.query('SELECT * FROM student_profiles')).rows;
    source.snapshot=async()=>({students:[{student_id:'DUP',name:'更新しない名前',status:'休会'},
      {student_id:'NEW',name:'新規正常',contract_plan:'エントリープラン',status:'アクティブ'}],tutors:[],
      reservations:[{calendar_event_id:'incoming',student_id:'DUP',lesson_date:'2026-10-20',title:'保留予約'},
        {calendar_event_id:'new',student_id:'NEW',lesson_date:'2026-10-22',title:'正常予約'}]});
    const result=await service.synchronize();assert.equal(result.heldStudents,1);assert.equal(result.synced,1);
    assert.deepEqual((await db.query("SELECT * FROM notion_students WHERE LOWER(student_number)='dup' ORDER BY notion_page_id")).rows,before);
    assert.deepEqual((await db.query('SELECT * FROM users WHERE id=$1',[users[0].id])).rows,users);
    assert.deepEqual((await db.query('SELECT * FROM student_profiles WHERE user_id=$1',[users[0].id])).rows,profiles);
    assert.equal((await db.query("SELECT tutor_name FROM central_students WHERE student_id='DUP'")).rows[0].tutor_name,'旧担当');
    assert.deepEqual((await db.query('SELECT event_id FROM central_reservations ORDER BY event_id')).rows.map(r=>r.event_id),['new','old']);
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/central',require('../src/routes/central'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
    const call=role=>fetch('http://127.0.0.1:'+server.address().port+'/api/central/duplicates',{headers:{Authorization:'Bearer '+jwt.sign({id:999,role},process.env.JWT_SECRET)}});
    for(const role of ['生徒','クルー']) assert.equal((await call(role)).status,403);
    for(const role of ['管理者','セールス']) {
      const response=await call(role);assert.equal(response.headers.get('cache-control'),'private, no-store');
      const body=await response.json();assert.equal(body.duplicateNumbers,1);assert.equal(body.duplicates.length,2);
      assert.equal(body.duplicates[0].student_number.toLowerCase(),'dup');
    }
    assert.equal((await service.synchronize()).accountsCreated,0);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    db.query=original.query;db.pool.connect=original.connect;source.snapshot=original.snapshot;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
