const test=require('node:test');
const assert=require('node:assert/strict');
const {calendar,forStudent}=require('../src/models/StudentReservations');
test('ダッシュボードは0回・1回の指定案内と前日ポップアップを表示し対象外は隠す',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),code=fs.readFileSync(require.resolve('../public/js/student-reservations.js'),'utf8');
  for(const count of [0,1,2]) {
    const element=()=>({hidden:true,textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}});
    const elements={'student-lessons-panel':element(),'student-lessons-content':element(),'lesson-reminder-body':element(),'lesson-reminder-dialog':element()};let shown=0;
    elements['lesson-reminder-dialog'].showModal=()=>shown++;
    const data={eligible:true,available:true,month:'2026-10',count,lessons:Array.from({length:count},()=>({date:'2026-10-09',time:'20:00',tutorName:'<not-html>'})),
      tomorrowLessons:[{date:'2026-10-09',time:'20:00',tutorName:'先生'}],lastSyncedAt:'2026-10-08T00:00:00Z'};
    const context={window:{ImportantMessageReady:Promise.resolve()},console,localStorage:{getItem:()=> 'test'},
      document:{getElementById:id=>elements[id],createElement:element,visibilityState:'visible',querySelector:()=>null},
      fetch:async()=>({ok:true,json:async()=>data}),setTimeout};
    vm.runInNewContext(code,context);await context.window.StudentReservations.load();
    assert.equal(elements['student-lessons-panel'].hidden,false);assert.equal(shown,1);
    const status=elements['student-lessons-content'].children[0];
    if(count===0) {assert.equal(status.className,'lesson-booking-zero');assert.match(status.textContent,/今月の予約が入っていません。2回分のご予約をお願いします/);}
    if(count===1) {assert.equal(status.className,'lesson-booking-one');assert.match(status.textContent,/今月の予約が1回しか入っていません。もう一日予約をお取りください/);}
    if(count===2) assert.equal(status.className,'');
    data.eligible=false;elements['student-lessons-panel'].hidden=true;await context.window.StudentReservations.load();
    assert.equal(elements['student-lessons-panel'].hidden,true);assert.equal(shown,1);
    data.eligible=true;data.available=false;await context.window.StudentReservations.load();
    assert.match(elements['student-lessons-content'].textContent,/予約情報を確認できません/);assert.equal(shown,1);
  }
});
test('当月と前日判定は日本時間・月末・年末で正しく区切る',()=>{
  assert.deepEqual(calendar(new Date('2026-10-31T14:59:00Z')),{month:'2026-10',tomorrow:'2026-11-01'});
  assert.deepEqual(calendar(new Date('2026-10-31T15:00:00Z')),{month:'2026-11',tomorrow:'2026-11-02'});
  assert.deepEqual(calendar(new Date('2026-12-31T00:00:00Z')),{month:'2026-12',tomorrow:'2027-01-01'});
});
test('本人だけの当月予約・翌月の明日を返しエントリーと未同期・重複を除外する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),original=db.query,env={...process.env};let server;
  db.query=(sql,params)=>pg.query(sql,params);process.env.CENTRAL_STUDENT_SYNC_ENABLED='true';process.env.JWT_SECRET='test-reservations';
  const now=new Date('2026-10-31T10:00:00Z');
  try {
    await require('../src/models/schema').createTables();
    await pg.exec(`INSERT INTO users(id,email,password,name,username,role) VALUES
      (1,'one@local','unused','本人','one','生徒'),(2,'two@local','unused','他人','two','生徒'),(3,'entry@local','unused','対象外','entry','生徒');
      INSERT INTO notion_students(notion_page_id,student_number,student_name,contract_plan) VALUES
      ('one','S1','本人','スタンダードプラン'),('two','S2','他人','PROプラン'),('entry','S3','対象外','エントリープラン');
      INSERT INTO student_profiles(user_id,notion_page_id) VALUES(1,'one'),(2,'two'),(3,'entry');
      INSERT INTO central_students(student_id,notion_page_id,synced_at) VALUES('S1','one',now()),('S2','two',now()),('S3','entry',now());
      INSERT INTO central_sync_state(id,last_success) VALUES(1,'2026-10-31');
      INSERT INTO central_reservations(event_id,student_id,lesson_date,lesson_time) VALUES
        ('past','S1','2026-10-01 00:00:00','22:00'),('today','S1','2026-10-31','21:00'),
        ('tomorrow','S1','2026-11-01','20:00'),('other','S2','2026-10-31','19:00'),('prev','S1','2026-09-30','18:00');`);
    let result=await forStudent(1,now);assert.equal(result.count,2);assert.equal(result.tomorrowLessons.length,1);
    assert.deepEqual(result.lessons.map(r=>r.time),['22:00','21:00']);
    assert.deepEqual(await forStudent(3,now),{eligible:false});
    await db.query("DELETE FROM central_reservations WHERE event_id='past'");assert.equal((await forStudent(1,now)).count,1);
    await db.query("DELETE FROM central_reservations WHERE event_id='today'");assert.equal((await forStudent(1,now)).count,0);
    await db.query("INSERT INTO notion_students(notion_page_id,student_number,student_name) VALUES('duplicate','s1','重複')");
    assert.equal((await forStudent(1,now)).available,false);
    await db.query("DELETE FROM notion_students WHERE notion_page_id='duplicate'");
    await db.query("UPDATE central_sync_state SET last_success='2026-09-30'");assert.equal((await forStudent(1,now)).available,false);
    await db.query('UPDATE central_sync_state SET last_success=CURRENT_TIMESTAMP');
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/central',require('../src/routes/central'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/api/central/my-lessons?studentId=S2';
    assert.equal((await fetch(url)).status,401);
    const call=(id,role)=>fetch(url,{headers:{Authorization:'Bearer '+jwt.sign({id,role},process.env.JWT_SECRET)}});
    for(const role of ['管理者','セールス','クルー']) assert.equal((await call(1,role)).status,403);
    const response=await call(1,'生徒');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    result=await response.json();assert.ok(result.lessons.every(lesson=>lesson.time!=='19:00'));
    assert.deepEqual(await (await call(3,'生徒')).json(),{eligible:false});
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));db.query=original;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
