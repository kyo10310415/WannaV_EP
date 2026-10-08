const test=require('node:test');
const assert=require('node:assert/strict');
const model=require('../src/models/TestStudentSettings');
const settings={name:'テスト生徒',studentNumber:'TEST-001',contractPlan:'スタンダードプラン',status:'アクティブ',lessonStartDate:'2026-10-01',
  lessons:[{date:'2026-10-09',time:'20:00',tutorName:'先生'}]};
test('テスト生徒設定はプラン・状態・実在日付・時刻・件数を検証する',()=>{
  assert.ok(model.validate(settings));
  for(const change of [{contractPlan:'unknown'},{status:'unknown'},{name:''},{lessonStartDate:'2026-02-30'},
    {lessons:[{date:'2026-10-09',time:'24:00',tutorName:''}]},{lessons:Array(51).fill(settings.lessons[0])}])
    assert.equal(model.validate({...settings,...change}),null);
});
test('手動設定は管理者だけがtest_seitoに保存でき、一般生徒・Notion連携を上書きしない',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),old={query:db.query,connect:db.pool.connect},env={...process.env};let server;
  db.query=(sql,params)=>pg.query(sql,params);db.pool.connect=async()=>({query:db.query,release(){}});
  process.env.JWT_SECRET='test-student-settings';process.env.CENTRAL_STUDENT_SYNC_ENABLED='false';
  try {
    await require('../src/models/schema').createTables();
    await pg.exec(`INSERT INTO users(id,email,password,name,username,role) VALUES
      (1,'test@local','unchanged','テスト','test_seito','生徒'),(2,'other@local','unchanged','普通生徒','other','生徒');`);
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());app.use('/api/central',require('../src/routes/central'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    const call=(role,method='GET',body)=>fetch(base+'/api/central/test-student',{method,headers:{Authorization:'Bearer '+jwt.sign({id:2,role},process.env.JWT_SECRET),'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
    for(const role of ['生徒','セールス','クルー']) {
      assert.equal((await call(role)).status,403);assert.equal((await call(role,'PUT',settings)).status,403);
    }
    assert.equal((await call('管理者','PUT',{...settings,userId:2})).status,200);
    const response=await call('管理者');assert.equal(response.headers.get('cache-control'),'private, no-store');
    const data=await response.json();assert.equal(data.id,1);assert.equal(data.student_number,'TEST-001');assert.equal(data.lessons.length,1);
    const users=(await db.query('SELECT id,name,password,username FROM users ORDER BY id')).rows;
    assert.equal(users[0].name,'テスト生徒');assert.equal(users[0].password,'unchanged');assert.equal(users[0].username,'test_seito');assert.equal(users[1].name,'普通生徒');
    const directory=await require('../src/models/StudentProfile').getDirectoryPage({search:'TEST-001'});
    assert.equal(directory.students[0].student_number,'TEST-001');
    const reservations=require('../src/models/StudentReservations');
    let result=await reservations.forStudent(1,new Date('2026-10-08T00:00:00Z'));
    assert.equal(result.manual,true);assert.equal(result.count,1);assert.equal(result.tomorrowLessons.length,1);
    assert.equal((await reservations.forStudent(2)).manual,undefined);
    await model.save(model.validate({...settings,lessons:[]}));assert.equal((await reservations.forStudent(1,new Date('2026-10-08T00:00:00Z'))).count,0);
    await model.save(model.validate({...settings,contractPlan:'エントリープラン'}));assert.deepEqual(await reservations.forStudent(1),{eligible:false});
    assert.equal((await call('管理者','PUT',{...settings,lessonStartDate:'2026-02-30'})).status,400);
    await db.query("INSERT INTO notion_students(notion_page_id,student_number,student_name,contract_plan) VALUES('linked','S1','本番連携','エントリープラン')");
    await db.query("UPDATE student_profiles SET notion_page_id='linked' WHERE user_id=1");
    assert.equal((await call('管理者')).status,404);assert.equal((await call('管理者','PUT',settings)).status,404);
    assert.deepEqual(await reservations.forStudent(1),{eligible:false});
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));db.query=old.query;db.pool.connect=old.connect;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
