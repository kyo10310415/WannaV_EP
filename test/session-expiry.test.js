const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const vm = require('vm');

test('JWT期限切れ・不正・設定異常とDB障害を区別し、通常の期限切れはstackを出さない', async () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'isolated-test-secret';
  const User = require('../src/models/User');
  const originalFind = User.findById, originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  User.findById = async () => ({id:1,role:'生徒',password_changed_at:'2026-01-01'});
  const app = express(); app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.get('/protected', require('../src/middleware/auth').auth, (_,res) => res.json({ok:true}));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  const valid = jwt.sign({id:1,role:'管理者'},process.env.JWT_SECRET,{expiresIn:'7d'});
  const expired = jwt.sign({id:1,role:'管理者'},process.env.JWT_SECRET,{expiresIn:-1});
  try {
    for (const endpoint of ['/api/auth/me','/api/auth/change-password','/protected']) {
      for (const [token,code] of [[expired,'TOKEN_EXPIRED'],['broken','INVALID_TOKEN']]) {
        const res = await fetch(base+endpoint,{method:endpoint.endsWith('change-password')?'POST':'GET',
          headers:{Authorization:'Bearer '+token}});
        assert.equal(res.status,401); assert.equal((await res.json()).code,code);
        assert.match(res.headers.get('set-cookie'),/portal_media=;.*Expires=/);
      }
    }
    assert.equal(errors.length,0);
    assert.equal((await fetch(base+'/protected',{headers:{Authorization:'Bearer '+valid}})).status,200);
    assert.equal((await fetch(base+'/api/auth/me',{headers:{Authorization:'Bearer '+valid}})).status,200);
    User.findById = async () => {throw new Error('simulated DB failure');};
    assert.equal((await fetch(base+'/api/auth/me',{headers:{Authorization:'Bearer '+valid}})).status,500);
    delete process.env.JWT_SECRET;
    assert.equal((await fetch(base+'/protected',{headers:{Authorization:'Bearer '+valid}})).status,500);
    assert.equal(errors.length,2);
  } finally {
    User.findById=originalFind;console.error=originalError;
    if(saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=saved;
    await new Promise(resolve => server.close(resolve));
  }
});

const source = fs.readFileSync(require.resolve('../public/js/session-expiry.js'),'utf8');
function browser(pathname='/',code='TOKEN_EXPIRED') {
  const local = new Map([['token','old']]), session = new Map(), redirects=[], handlers={};
  const storage = map => ({getItem:key=>map.get(key),setItem:(key,val)=>map.set(key,val),removeItem:key=>map.delete(key)});
  let calls=0;
  const alert={textContent:'',setAttribute(){}};
  const window={location:{origin:'https://portal.example',pathname,search:'',replace:url=>redirects.push(url)},
    history:{replaceState(){}},fetch:async()=>{calls++;return {status:401,clone:()=>({json:async()=>({code})})};}};
  const context={window,Request,URL,URLSearchParams,localStorage:storage(local),sessionStorage:storage(session),
    document:{getElementById:()=>alert,addEventListener:(event,fn)=>handlers[event]=fn}};
  vm.runInNewContext(source,context);
  return {window,local,session,redirects,handlers,alert,calls:()=>calls};
}

test('同時401でもtoken削除・redirectは一度、retryなし、ログイン画面はreloadしない',async()=>{
  const b=browser('/dashboard');
  await Promise.all([b.window.fetch('/api/auth/me'),b.window.fetch('/api/lessons'),b.window.fetch('/api/admin/users')]);
  assert.equal(b.local.has('token'),false);assert.equal(b.session.get('portal-session-expired'),'1');
  assert.deepEqual(b.redirects,['/?session=expired']);assert.equal(b.calls(),3);
  const login=browser();await login.window.fetch('/api/auth/change-password');
  assert.equal(login.redirects.length,0);assert.match(login.alert.textContent,/有効期限/);
  login.handlers.DOMContentLoaded();assert.equal(login.session.has('portal-session-expired'),false);
});

test('外部URLの401と通常のログインエラーでは既存tokenを削除しない',async()=>{
  const b=browser('/dashboard');await b.window.fetch('https://external.example/api/data');
  assert.equal(b.local.get('token'),'old');assert.equal(b.redirects.length,0);
  const invalid=browser('/','INVALID_TOKEN');await invalid.window.fetch('/api/auth/login');
  assert.equal(invalid.local.get('token'),'old');assert.equal(invalid.redirects.length,0);
});

test('全HTML画面でAPI実行前にセッション期限切れハンドラを読み込む',()=>{
  const path=require('path'),dir=path.join(__dirname,'../views');
  for(const file of fs.readdirSync(dir).filter(file=>file.endsWith('.html'))) {
    assert.match(fs.readFileSync(path.join(dir,file),'utf8'),/<head>\s*<script src="\/js\/session-expiry.js"><\/script>/);
  }
});
