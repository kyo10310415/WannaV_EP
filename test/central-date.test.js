const test=require('node:test');
const assert=require('node:assert/strict');
const {mapStudents}=require('../src/services/centralStudentSync');

test('中央開始日は実在する日付のみ受理し、空欄・閏年と特殊値を区別する',()=>{
  const parse=date=>mapStudents([{student_id:'TEST',name:'日付テスト',lesson_start_date:date}],[])[0];
  assert.equal(parse('2024-02-29').lessonStartMonth,'2024-02-29');
  assert.equal(parse(null).lessonStartMonth,null);
  assert.equal(parse('  ').lessonStartMonth,null);
  assert.equal(parse(' 2026/9/1 ').lessonStartMonth,'2026-09-01');
  assert.equal(parse('2026-9-1').lessonStartMonth,'2026-09-01');
  for(const value of ['2026-02-29','2026-02-30','2026/2/30','2026/10-08','08/10/2026','infinity','-infinity','2026-13-01']) {
    assert.throws(()=>parse(value),error=>error.code==='INVALID_DATE');
  }
});

test('中央DBのDateStyleが異なっても開始日はISO形式で読み取る', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const source=require('../src/config/centralDatabase'),env={...process.env};
  Object.assign(process.env,{CENTRAL_STUDENT_SYNC_ENABLED:'true',CENTRAL_DATABASE_URL:'postgres://test:placeholder@localhost/date-test',CENTRAL_DATABASE_SSL:'false'});
  const pool=source.getPool(),original=pool.connect;
  try {
    await pg.exec(`CREATE TABLE students(student_id text,name text,status text,contract_plan text,homeroom_tutor text,
      notion_page_id text,notion_url text,lesson_start_date date,x_account_id text,youtube_channel_id text);
      CREATE TABLE tutors(notion_name text,name text,tutor_name text,email text);
      CREATE TABLE lessons(calendar_event_id text,student_id text,tutor_name text,lesson_date timestamp,lesson_time text,title text);
      INSERT INTO students(student_id,name,lesson_start_date) VALUES('A','日付テスト',DATE '2026-10-08'),('B','未設定',NULL),('C','特殊値','infinity');`);
    pool.connect=async()=>({query:(sql,params)=>pg.query(sql,params),release(){}});
    for(const style of ['ISO, MDY','SQL, DMY','German, DMY']) {
      await pg.query('SET DateStyle TO '+"'"+style+"'");
      const result=await source.snapshot();
      assert.equal(result.students[0].lesson_start_date,'2026-10-08');
      assert.equal(result.students[1].lesson_start_date,null);
      assert.equal(result.students[2].lesson_start_date,'infinity');
      assert.equal(mapStudents([result.students[0]],[])[0].lessonStartMonth,'2026-10-08');
      assert.equal((await pg.query('SHOW DateStyle')).rows[0].DateStyle,style);
    }
    await pg.exec(`ALTER TABLE students ALTER COLUMN lesson_start_date TYPE text USING lesson_start_date::text;
      UPDATE students SET lesson_start_date=' 2026/10/8 ' WHERE student_id='A';
      INSERT INTO students(student_id,name,lesson_start_date) VALUES('D','空欄','');`);
    const result=await source.snapshot();
    assert.equal(mapStudents([result.students[0]],[])[0].lessonStartMonth,'2026-10-08');
    assert.equal(mapStudents([result.students[3]],[])[0].lessonStartMonth,null);
    assert.throws(()=>mapStudents([result.students[2]],[]),error=>error.code==='INVALID_DATE');
  } finally {
    pool.connect=original;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
