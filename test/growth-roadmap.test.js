const test=require('node:test');
const assert=require('node:assert/strict');
const model=require('../src/models/GrowthRoadmap');
test('ロードマップは18行・現在地・5ヶ月目の応援文を描画し未取得と0人を区別する',()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  const element=()=>({hidden:true,children:[],attributes:{},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},setAttribute(key,value){this.attributes[key]=value;}});
  const elements=Object.fromEntries(['growth-roadmap','growth-position','growth-comparisons','growth-goals-body'].map(id=>[id,element()]));
  const context={window:{},document:{getElementById:id=>elements[id],createElement:element},console};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/growth-roadmap.js'),'utf8'),context);
  const data={eligible:true,currentMonth:5,goals:model.GOALS,current:{x:{count:250,fetchedAt:'2026-10-08T00:00:00Z'},youtube:{count:null,fetchedAt:null}}};
  context.window.GrowthRoadmap.render(data);
  assert.equal(elements['growth-goals-body'].children.length,18);
  const row=elements['growth-goals-body'].children[4];assert.equal(row.attributes['aria-current'],'step');assert.match(row.children[3].textContent,/目指せ、Live2Dデビュー/);
  assert.match(elements['growth-comparisons'].children[0].children[3].textContent,/あと250人/);
  assert.match(elements['growth-comparisons'].children[1].children[1].textContent,/未取得/);
  data.currentMonth=1;data.current.x.count=0;context.window.GrowthRoadmap.render(data);
  assert.match(elements['growth-comparisons'].children[0].children[1].textContent,/最新取得：0人/);
  assert.match(elements['growth-comparisons'].children[0].children[2].textContent,/準備期間/);
  context.window.GrowthRoadmap.render({eligible:false});assert.equal(elements['growth-roadmap'].hidden,true);
});
test('18ヶ月の指標と日本時間の暦月・5ヶ月目までの境界',()=>{
  assert.deepEqual(model.GOALS.map(g=>[g.x,g.youtube]),[[0,0],[0,0],[100,0],[250,0],[500,0],[750,25],[1000,50],[1250,75],[1500,100],[1750,125],[2000,150],[2150,250],[2300,350],[2450,450],[2600,550],[2800,650],[3000,700],[3500,800]]);
  assert.equal(model.currentMonth('2026-10-31',new Date('2027-02-28T14:59:00Z')),5);
  assert.equal(model.currentMonth('2026-10-31',new Date('2027-02-28T15:00:00Z')),6);
  assert.equal(model.currentMonth('2026-11-01',new Date('2026-10-08T00:00:00Z')),0);
  assert.equal(model.currentMonth('2026-02-30'),null);
  assert.deepEqual(model.latestMetric({status:'ok',count:0,fetchedAt:'2026-10-08T00:00:00Z',history:[]}),{count:0,fetchedAt:'2026-10-08T00:00:00Z'});
  assert.deepEqual(model.latestMetric(null),{count:null,fetchedAt:null});
});
test('対象プラン・本人・開始月を確認しSNSの最新成功値を比較する',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),pg=new PGlite();
  const db=require('../src/config/database'),{SocialMetrics}=require('../src/models/SocialMetrics');
  const original={query:db.query,user:SocialMetrics.forUser,page:SocialMetrics.forPage},env={...process.env};let server,calls=0;
  db.query=(sql,params)=>pg.query(sql,params);process.env.JWT_SECRET='roadmap-test';
  SocialMetrics.forUser=SocialMetrics.forPage=async()=>{calls++;return {platforms:{x:{status:'pending',history:[{count:120,fetchedAt:'2026-10-07T00:00:00Z'},{count:100,fetchedAt:'2026-10-01T00:00:00Z'}]},youtube:{status:'hidden',history:[]}}};};
  try {
    await require('../src/models/schema').createTables();
    await pg.exec(`INSERT INTO users(id,email,password,name,username,role) VALUES(1,'one@local','unused','生徒','test_seito','生徒');
      INSERT INTO student_profiles(user_id,contract_plan,lesson_start_date) VALUES(1,'スタンダードプラン','2026-06-30');
      INSERT INTO test_student_settings(user_id,text_type) VALUES(1,'新');`);
    const now=new Date('2026-10-08T00:00:00Z');let result=await model.forStudent(1,now);
    assert.equal(result.eligible,true);assert.equal(result.currentMonth,5);assert.equal(result.goals.length,18);assert.equal(result.current.x.count,120);assert.equal(result.current.youtube.count,null);
    await db.query("UPDATE student_profiles SET contract_plan='生徒プラン'");assert.equal((await model.forStudent(1,now)).eligible,true);
    for(const plan of ['エントリープラン','PROプラン','プレミアムプラン','永久会員']) {
      await db.query('UPDATE student_profiles SET contract_plan=$1',[plan]);assert.equal((await model.forStudent(1,now)).eligible,false);
    }
    assert.equal(calls,2);
    await db.query("UPDATE test_student_settings SET text_type='旧'");assert.equal((await model.forStudent(1,now)).eligible,false);
    await db.query("UPDATE test_student_settings SET text_type='新'");
    await db.query("UPDATE student_profiles SET contract_plan='スタンダードプラン',lesson_start_date='2026-05-01'");assert.equal((await model.forStudent(1,now)).eligible,false);
    await db.query("UPDATE student_profiles SET lesson_start_date='2026-11-01'");assert.equal((await model.forStudent(1,now)).eligible,false);
    await db.query("UPDATE student_profiles SET lesson_start_date=NULL");assert.equal((await model.forStudent(1,now)).eligible,false);
    await db.query(`INSERT INTO notion_students(notion_page_id,student_number,student_name,contract_plan,lesson_start_month,raw_data)
      VALUES('central-page','S1','生徒','スタンダードプラン','2026-06-01','{"source":"central","textType":"新"}')`);
    await db.query("UPDATE student_profiles SET notion_page_id='central-page'");assert.equal((await model.forStudent(1,now)).eligible,true);
    for(const raw of [{source:'central',textType:'旧'},{source:'central'},{source:'notion_pending',textType:'新'}]) {
      await db.query('UPDATE notion_students SET raw_data=$1::jsonb',[JSON.stringify(raw)]);assert.equal((await model.forStudent(1,now)).eligible,false);
    }
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use('/api/central',require('../src/routes/central'));
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));const url='http://127.0.0.1:'+server.address().port+'/api/central/my-growth?userId=1';
    for(const role of ['管理者','セールス','クルー']) assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+jwt.sign({id:1,role},process.env.JWT_SECRET)}})).status,403);
    const response=await fetch(url,{headers:{Authorization:'Bearer '+jwt.sign({id:999,role:'生徒'},process.env.JWT_SECRET)}});
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{eligible:false});
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));db.query=original.query;SocialMetrics.forUser=original.user;SocialMetrics.forPage=original.page;
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);await pg.close();
  }
});
