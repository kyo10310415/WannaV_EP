const test=require('node:test');
const assert=require('node:assert/strict');
test('管理者の固定PWリセットは生徒を除外し旧セッションを失効、初回変更を強制する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),original=db.query,env={...process.env};let server;
  db.query=(sql,params)=>pg.query(sql,params);process.env.JWT_SECRET='staff-reset-test';
  try {
    await require('../src/models/schema').createTables();
    const User=require('../src/models/User'),admin=await User.create('admin','old-pass','管理者','管理者'),crew=await User.create('crew','old-pass','クルー','クルー'),student=await User.create('student','old-pass','生徒','生徒');
    await db.query('UPDATE users SET password_changed_at=CURRENT_TIMESTAMP');
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());
    app.use('/api/admin',require('../src/routes/admin'));app.use('/api/auth',require('../src/routes/auth'));
    app.get('/protected',require('../src/middleware/auth').auth,(req,res)=>res.json({ok:true}));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    const adminToken=jwt.sign({id:admin.id,role:'管理者'},process.env.JWT_SECRET),crewToken=jwt.sign({id:crew.id,role:'クルー'},process.env.JWT_SECRET);
    const request=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request('/api/admin/users/'+crew.id+'/reset-password',crewToken,'POST')).status,403);
    assert.equal((await request('/api/admin/users/'+student.id+'/reset-password',adminToken,'POST')).status,404);
    assert.equal((await request('/api/admin/users/invalid/reset-password',adminToken,'POST')).status,400);
    assert.equal((await request('/api/admin/users/'+crew.id+'/reset-password',adminToken,'POST')).status,200);
    const reset=(await db.query('SELECT * FROM users WHERE id=$1',[crew.id])).rows[0];
    assert.equal(reset.password_changed_at,null);assert.equal(await User.verifyPassword('1111',reset.password),true);assert.equal(await User.verifyPassword('old-pass',reset.password),false);
    for(const path of ['/protected','/api/auth/me']) assert.equal((await request(path,crewToken)).status,401);
    assert.equal((await request('/api/auth/change-password',crewToken,'POST',{newPassword:'hijack-pass'})).status,401);
    const login=await request('/api/auth/login','unused','POST',{email:'crew',password:'1111'});const data=await login.json();assert.equal(data.needsPasswordChange,true);
    assert.equal((await request('/protected',data.token)).status,403);
    assert.equal((await request('/api/auth/change-password',data.token,'POST',{newPassword:'1111'})).status,400);
    const change=await request('/api/auth/change-password',data.token,'POST',{newPassword:'new-secure-pass'});assert.equal(change.status,200);
    const refreshed=(await change.json()).token;assert.equal((await request('/protected',refreshed)).status,200);
    // Existing direct PW change keeps its immediate-change semantics.
    assert.equal((await request('/api/admin/users/'+crew.id+'/password',adminToken,'PATCH',{newPassword:'direct-pass'})).status,200);
    assert.ok((await User.findById(crew.id)).password_changed_at);
    assert.equal((await request('/api/admin/users/'+crew.id+'/reset-password',adminToken,'POST')).status,200);
    assert.equal((await request('/protected',refreshed)).status,401);
    assert.equal(await User.verifyPassword('old-pass',(await db.query('SELECT password FROM users WHERE id=$1',[student.id])).rows[0].password),true);
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));db.query=original;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
