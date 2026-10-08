const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const vm=require('vm');
const {classify}=require('../src/utils/centralSyncError');

test('中央同期診断は固定の分類だけ返し、秘密情報・SQL・個人情報を返さない',()=>{
  for(const code of ['28P01','42501','42703','42883','42804','ENOTFOUND','ETIMEDOUT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','malicious-secret']) {
    const raw=Object.assign(new Error('postgres://user:secret@private/db SELECT student_name private-person'),{code});
    const safe=classify(raw,'source_students');
    assert.equal(safe.stage,'source_students');
    assert.ok(!safe.message.includes('secret'));assert.ok(!safe.message.includes('private-person'));assert.ok(!safe.message.includes('SELECT'));
    assert.notEqual(safe.code,'malicious-secret');
    if (['42883','42804'].includes(code)) assert.equal(safe.code,code);
  }
  assert.equal(classify(new Error('The server does not support SSL connections'),'source_connect').code,'TLS_MODE_MISMATCH');
});

test('中央DBの不足列エラーは失敗したSELECTの段階とコードを保持し、接続を解放する',async()=>{
  const source=require('../src/config/centralDatabase'),env={...process.env};
  Object.assign(process.env,{CENTRAL_STUDENT_SYNC_ENABLED:'true',CENTRAL_DATABASE_URL:'postgres://test:placeholder@localhost/diagnostics',CENTRAL_DATABASE_SSL:'false'});
  const pool=source.getPool(),original=pool.connect;let released=0,rolledBack=false;
  pool.connect=async()=>({query:async sql=>{
    if(sql.includes('FROM tutors')) throw Object.assign(new Error('secret SQL and personal details'),{code:'42703'});
    if(sql==='ROLLBACK')rolledBack=true;
    return {rows:[]};
  },release:()=>released++});
  try {
    await assert.rejects(source.snapshot(),error=>error.code==='42703' && error.stage==='source_tutors' && !error.message.includes('secret'));
    assert.equal(released,1);assert.equal(rolledBack,true);
    pool.connect=async()=>{throw Object.assign(new Error('private-host secret'),{code:'ENOTFOUND'});};
    await assert.rejects(source.snapshot(),error=>error.code==='ENOTFOUND' && error.stage==='source_connect');
  } finally {
    pool.connect=original;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
  }
});

const html=fs.readFileSync(require.resolve('../views/admin-student-management.html'),'utf8');
const syncFunction=html.slice(html.indexOf('async function syncNotionStudents('),html.indexOf('function updateStats('));
test('同期結果はボタン付近に継続表示され、エラーの段階・コードとボタン復旧を確認できる',async()=>{
  const output={textContent:''},button={disabled:false,textContent:''};let alerts=0;
  const context={document:{getElementById:id=>id==='notion-sync-button'?button:output},AbortController,setTimeout,clearTimeout,
    centralEnabled:true,fetchJSON:async()=>({error:'必要な列がありません',code:'42703',stage:'source_tutors'}),showAlert:()=>alerts++,loadStudents:async()=>{},loadCentralStatus:async()=>{}};
  vm.runInNewContext(syncFunction,context);await context.syncNotionStudents();
  assert.match(output.textContent,/42703.*source_tutors/);assert.equal(button.disabled,false);assert.equal(alerts,1);
  assert.match(html,/id="student-sync-result" role="status"/);
  assert.match(html,/result\.sync\?\.lastError/);
});

test('同期応答が長引いた場合も待機解除と継続中の案内を表示する',async()=>{
  const output={textContent:''},button={disabled:false};
  const context={document:{getElementById:id=>id==='notion-sync-button'?button:output},AbortController,
    setTimeout:fn=>{fn();return 1;},clearTimeout(){},centralEnabled:true,fetchJSON:async()=>null,showAlert(){}};
  vm.runInNewContext(syncFunction,context);await context.syncNotionStudents();
  assert.equal(button.disabled,false);assert.match(output.textContent,/60秒以上/);assert.match(output.textContent,/継続している可能性/);
});
