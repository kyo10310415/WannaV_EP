const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const db=require('../src/config/database');
const User=require('../src/models/User');

test('生徒アカウントは変更済みログインIDでも学籍番号・同期生徒名から検索できる',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),original=db.query;
  try {
    await pg.exec(`CREATE TABLE users(id int,email text,name text,username text,role text,created_at timestamp,last_login timestamp,password_changed_at timestamp);
      CREATE TABLE student_profiles(user_id int,notion_page_id text);
      CREATE TABLE notion_students(notion_page_id text,student_number text,student_name text);
      INSERT INTO users(id,email,name,username,role,created_at) VALUES
        (1,'one@local','旧名','custom-login','生徒',now()),(2,'two@local','手動生徒','test_seito','生徒',now()),
        (3,'staff@local','検索対象','ABC_100','管理者',now());
      INSERT INTO student_profiles VALUES(1,'page');
      INSERT INTO notion_students VALUES('page','ABC_100','同期生徒名');`);
    db.query=(sql,params)=>pg.query(sql,params);
    for(const term of ['ABC_100','同期生徒','custom-login']) {
      const result=await User.getPage('students',{search:term});
      assert.deepEqual(result.users.map(u=>u.id),[1]);assert.equal(result.pagination.total,1);
    }
    assert.deepEqual((await User.getPage('students',{search:'手動生徒'})).users.map(u=>u.id),[2]);
    assert.equal((await User.getPage('students',{search:'%'})).users.length,0);
    assert.equal((await User.getPage('students',{search:'該当なし'})).pagination.total,0);
    const first=await User.getPage('students',{search:'生徒',limit:1});
    assert.equal(first.pagination.total,2);assert.equal(first.pagination.hasMore,true);
    assert.equal((await User.getPage('students',{search:'生徒',limit:1,offset:1})).users.length,1);
  } finally {db.query=original;await pg.close();}
});

test('検索をページ切替で保持し古い一覧応答で上書きしない',async()=>{
  const html=fs.readFileSync(require.resolve('../views/admin-students-accounts.html'),'utf8');
  const code=html.slice(html.indexOf('const STUDENT_PAGE_SIZE'),html.indexOf('function renderStudentPagination'));
  const pending=[],rendered=[];
  const context={API_URL:'/api',localStorage:{getItem:()=> 'test'},encodeURIComponent,console,
    fetch:url=>new Promise(resolve=>pending.push({url,resolve})),renderUsers:users=>rendered.push(users),renderStudentPagination(){},showAlert(){}};
  vm.runInNewContext(code+"\nstudentSearch='学籍_1';",context);
  const old=context.loadStudentUsers(0),latest=context.loadStudentUsers(50);
  assert.match(pending[1].url,/offset=50&search=/);assert.ok(pending[1].url.endsWith(encodeURIComponent('学籍_1')));
  pending[1].resolve({ok:true,json:async()=>({users:[{id:2,role:'生徒'}]})});await latest;
  pending[0].resolve({ok:true,json:async()=>({users:[{id:1,role:'生徒'}]})});await old;
  assert.equal(rendered.length,1);assert.equal(rendered[0][0].id,2);
  assert.match(html,/studentSearch = document.getElementById\('student-search'\).value.trim\(\);\s+loadStudentUsers\(0\)/);
});
