const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const Usage=require('../src/models/ToolUsage');
test('生徒ツール利用は空ページで集計クエリーを発行しない',async()=>{
  const db=require('../src/config/database'),old=db.query;db.query=()=>{throw new Error('must not query');};try{assert.equal((await Usage.forStudents([null,undefined,0,'invalid'])).size,0);}finally{db.query=old;}
});
test('隔離DB：ツール別累計・日本時間の当月・失敗除外・履歴削除後の保持・担当範囲',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite(),db=require('../src/config/database'),old={query:db.query,env:{...process.env}};let server;
  db.query=(s,p)=>pg.query(s,p);
  try{Object.assign(process.env,{JWT_SECRET:'isolated-usage',PAYMENT_ACCESS_CONTROL_ENABLED:'false'});await require('../src/models/schema').createTables();
    const User=require('../src/models/User'),a=await User.create('usage-a','dummy','A'),b=await User.create('usage-b','dummy','B'),unused=await User.create('usage-unused','dummy','未使用'),crew=await User.create('usage-crew','dummy','クルー','クルー'),admin=await User.create('usage-admin','dummy','管理者','管理者'),sales=await User.create('usage-sales','dummy','セールス','セールス');
    await pg.query("INSERT INTO student_profiles(user_id,status,contract_plan,assigned_tutor_id) VALUES($1,'アクティブ','エントリープラン',$4),($2,'アクティブ','エントリープラン',NULL),($3,'アクティブ','エントリープラン',NULL)",[a.id,b.id,unused.id,crew.id]);
    const thread=randomUUID();await pg.query("INSERT INTO tool_threads(id,user_id,title,deleted_at) VALUES($1,$2,'削除済み',CURRENT_TIMESTAMP)",[thread,a.id]);
    const put=async(user,key,status,when='CURRENT_TIMESTAMP',threadId=null)=>pg.query(`INSERT INTO tool_usage(id,user_id,thread_id,tool_key,status,created_at) VALUES($1,$2,$3,$4,$5,${when})`,[randomUUID(),user,threadId,key,status]);
    const month="date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'";
    await put(a.id,'obs-master','completed','CURRENT_TIMESTAMP',thread);await put(a.id,'obs-master','completed',`(${month})-INTERVAL '1 second'`);await put(a.id,'obs-master','completed',month);
    await put(a.id,'kanau','completed');await put(a.id,'youtube-game-strategy','completed');
    for(const status of ['pending','unknown','incomplete'])await put(a.id,'obs-master',status);
    await put(b.id,'obs-master','completed');
    const map=await Usage.forStudents([a.id,b.id,unused.id,a.id]);assert.equal(map.size,3);assert.equal(map.get(a.id).length,6);
    const obs=map.get(a.id).find(x=>x.key==='obs-master');assert.equal(obs.total,3);assert.equal(obs.current_month,2);assert.ok(map.get(unused.id).every(x=>x.total===0&&x.current_month===0));
    assert.equal(map.get(b.id).find(x=>x.key==='obs-master').total,1);
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/students',require('../src/routes/students'));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/students';
    const req=(user,suffix='')=>fetch(url+suffix,{headers:user?{Authorization:'Bearer '+jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET)}:{}});
    assert.equal((await req(null)).status,401);assert.equal((await req(a)).status,403);
    for(const user of [admin,sales]){const r=await req(user);assert.equal(r.status,200);const data=await r.json();assert.equal(data.students.length,3);assert.equal(data.students.find(x=>x.user_id===a.id).tool_usage.find(x=>x.key==='obs-master').total,3);assert.ok(!JSON.stringify(data).includes('削除済み'));}
    const assigned=await(await req(crew,'?tutorId='+admin.id)).json();assert.equal(assigned.students.length,1);assert.equal(assigned.students[0].user_id,a.id);assert.equal(assigned.students[0].tool_usage.find(x=>x.key==='kanau').total,1);
    const limited=await(await req(admin,'?limit=1')).json();assert.equal(limited.students.length,1);assert.equal(limited.students[0].tool_usage.length,6);
  }finally{db.query=old.query;process.env=old.env;if(server)await new Promise(r=>server.close(r));await pg.close();}
});
