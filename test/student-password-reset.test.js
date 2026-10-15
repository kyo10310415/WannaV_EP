const test=require('node:test');
const assert=require('node:assert/strict');
test('生徒用リセットボタンは確認・管理者チェック・二重送信防止・一覧再読込を行う',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync(require.resolve('../views/admin-students-accounts.html'),'utf8');
  const code=html.slice(html.indexOf('async function resetStudentToInitialPassword('),html.indexOf('function openPasswordReset('));
  let calls=0,loads=0,confirmed=true;
  const button={disabled:false},context={currentUser:{role:'管理者'},confirm:()=>confirmed,API_URL:'/api',localStorage:{getItem:()=> 'token'},
    fetch:async(url,options)=>{calls++;assert.equal(url,'/api/admin/students/42/reset-password');assert.equal(options.method,'POST');assert.equal(button.disabled,true);return {ok:true,json:async()=>({message:'保存済み'})};},
    showAlert(){},loadStudentUsers:async()=>loads++};
  vm.runInNewContext(code,context);await context.resetStudentToInitialPassword(42,button);
  assert.equal(calls,1);assert.equal(loads,1);assert.equal(button.disabled,false);
  confirmed=false;await context.resetStudentToInitialPassword(42,button);assert.equal(calls,1);
  confirmed=true;context.currentUser.role='セールス';await context.resetStudentToInitialPassword(42,button);assert.equal(calls,1);
  assert.match(html,/openPasswordReset\(\$\{user.id\}/);assert.match(html,/resetStudentToInitialPassword\(\$\{user.id\}, this\)/);
});
test('生徒PWリセットは管理者限定・生徒限定で初回変更と旧セッション失効を適用する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),original=db.query,env={...process.env};let server;
  db.query=(sql,params)=>pg.query(sql,params);process.env.JWT_SECRET='student-reset-test';
  try {
    await require('../src/models/schema').createTables();
    const User=require('../src/models/User'),admin=await User.create('admin','old-pass','管理者','管理者'),student=await User.create('student','old-pass','生徒','生徒');
    await db.query('UPDATE users SET password_changed_at=CURRENT_TIMESTAMP');
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());
    app.use('/api/admin',require('../src/routes/admin'));app.use('/api/auth',require('../src/routes/auth'));
    app.get('/protected',require('../src/middleware/auth').auth,(req,res)=>res.json({ok:true}));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    const token=(role,id=admin.id)=>jwt.sign({id,role},process.env.JWT_SECRET);
    const request=(path,session,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+session,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const path='/api/admin/students/'+student.id+'/reset-password',oldToken=token('生徒',student.id);
    for(const role of ['生徒','セールス','クルー']) assert.equal((await request(path,token(role),'POST')).status,403);
    assert.equal((await request('/api/admin/students/'+admin.id+'/reset-password',token('管理者'),'POST')).status,404);
    assert.equal((await request('/api/admin/students/invalid/reset-password',token('管理者'),'POST')).status,400);
    assert.equal((await request(path,token('管理者'),'POST',{newPassword:'must-ignore'})).status,200);
    const reset=(await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0];
    assert.equal(reset.password_changed_at,null);assert.ok(await User.verifyPassword('1111',reset.password));assert.ok(!await User.verifyPassword('old-pass',reset.password));
    assert.equal((await request('/protected',oldToken)).status,401);
    assert.equal((await request('/api/auth/me',oldToken)).status,401);
    assert.equal((await request('/api/auth/change-password',oldToken,'POST',{newPassword:'old-token-hijack'})).status,401);
    const login=await (await request('/api/auth/login','unused','POST',{email:'student',password:'1111'})).json();
    assert.equal(login.needsPasswordChange,true);assert.equal((await request('/protected',login.token)).status,403);
    assert.equal((await request('/api/auth/change-password',login.token,'POST',{newPassword:'1111'})).status,400);
    const changed=await request('/api/auth/change-password',login.token,'POST',{newPassword:'new-password'});assert.equal(changed.status,200);
    const refreshed=(await changed.json()).token;assert.equal((await request('/protected',refreshed)).status,200);
    assert.equal((await request(path,token('管理者'),'POST')).status,200);assert.equal((await request('/protected',refreshed)).status,401);
    assert.ok(await User.verifyPassword('old-pass',(await db.query('SELECT password FROM users WHERE id=$1',[admin.id])).rows[0].password));
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));db.query=original;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
