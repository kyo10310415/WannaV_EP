const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{EventEmitter}=require('events'),{randomUUID}=require('crypto');
const file=process.env.AUDIT_ROUTER||require('path').join(__dirname,'../src/routes/tools.js');
const tick=()=>new Promise(setImmediate);
function harness({uploadError=false,deferUpload=false}={}){
 const routes=[],pending=[],uploads=[],queries=[],tasks=[];let started=0,deletions=0;
 class TrackedSet extends Set{delete(x){deletions++;return super.delete(x);}}
 const service={config:()=>({enabled:true,model:'synthetic'}),attachment:x=>x,answer:()=>{started++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
 const query=async(sql,p)=>{queries.push(sql);return {rows:sql.includes('SELECT * FROM tool_threads')?[{id:p[0],busy_until:null}]:sql.includes('FILTER(')?[{daily:0,monthly:0}]:sql.includes('octet_length')?[{n:0,bytes:0}]:[]}};
 const db={query,pool:{connect:async()=>({query,release(){}})}};
 const router={use(){},get(){},delete(){},post(path,...handlers){routes.push({path,handlers});}};
 const sandbox={module:{exports:{}},require:n=>n==='express'?{Router:()=>router}:n==='multer'?Object.assign(()=>({array:()=>(q,r,cb)=>{if(deferUpload)uploads.push(cb);else cb(uploadError?new Error('synthetic upload error'):null)}}),{memoryStorage:()=>({})}):n==='crypto'?{randomUUID}:n.includes('database')?db:n.includes('middleware/auth')?{auth(){},checkRole:()=>()=>{}}:n.includes('services/')?service:require(n),Buffer,console,Set:TrackedSet,Date,Number,Object,JSON};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox);
 const h=routes.find(r=>r.path==='/threads/:id/messages').handlers;
 async function request(id=1,invalid=false){
  const q=new EventEmitter();Object.assign(q,{user:{id},params:{id:invalid?'invalid':randomUUID()},body:{text:'synthetic',requestId:randomUUID()},files:[]});
  const r=new EventEmitter();Object.assign(r,{headersSent:false,status(c){this.code=c;return this},json(value){this.body=value;this.code=this.code||200;this.headersSent=true;this.emit('finish');return this}});
  h[0](q,r,()=>{tasks.push(h[1](q,r));});await tick();return {q,r};
 }
 const result={complete:true,model:'synthetic',usage:{input_tokens:1,output_tokens:1},text:'synthetic',citations:[],searches:0,usd:null};
 const settle=async(reject=false)=>{for(const p of pending.splice(0))reject?p.reject(new Error('synthetic failure')):p.resolve(result);await Promise.all(tasks);};
 return {request,settle,uploads,queries,get started(){return started},get deletions(){return deletions}};
}
test('disconnect does not bypass global four in-flight operations',async()=>{
 const h=harness();try{for(let i=1;i<=5;i++){const r=await h.request(i);r.r.emit('close');}assert.equal(h.started,4);}finally{await h.settle();}
});
test('same user cannot start another thread while disconnected operation runs',async()=>{
 const h=harness();try{(await h.request()).r.emit('close');const second=await h.request();assert.equal(second.r.code,429);assert.equal(h.started,1);}finally{await h.settle();}
});
test('disconnected success still records billing and assistant, clears busy and releases once',async()=>{
 const h=harness(),r=await h.request();r.r.emit('close');await h.settle();assert.ok(h.queries.some(s=>s.includes('UPDATE tool_usage SET status=$2')));assert.ok(h.queries.some(s=>s.includes("'assistant'")));assert.ok(h.queries.some(s=>s.includes('busy_until=NULL')));assert.equal(h.deletions,1);
 await h.request();assert.equal(h.started,2);await h.settle();
});
test('disconnected failure records unknown and clears busy and releases once',async()=>{
 const h=harness(),r=await h.request();r.r.emit('close');await h.settle(true);assert.ok(h.queries.some(s=>s.includes("status='unknown'")));assert.ok(h.queries.some(s=>s.includes('busy_until=NULL')));assert.equal(h.deletions,1);await h.request();assert.equal(h.started,2);await h.settle();
});
test('normal success releases once and next request can run',async()=>{
 const h=harness();await h.request();await h.settle();assert.equal(h.deletions,1);await h.request();assert.equal(h.started,2);await h.settle();
});
test('validation and multipart errors release once without provider call',async()=>{
 const h=harness();const r=await h.request(1,true);assert.equal(r.r.code,400);assert.equal(h.started,0);assert.equal(h.deletions,1);
 const bad=harness({uploadError:true});const b=await bad.request();assert.equal(b.r.code,400);assert.equal(bad.started,0);assert.equal(bad.deletions,1);
});
test('pre-parse disconnect releases once, stale callback cannot clear newer reservation',async()=>{
 const h=harness({deferUpload:true});(await h.request()).r.emit('close');assert.equal(h.deletions,1);const second=await h.request();h.uploads[0]();await tick();assert.equal(h.started,0);assert.equal(h.deletions,1);
 const blocked=await h.request();assert.equal(blocked.r.code,429);h.uploads[1]();await tick();assert.equal(h.started,1);await h.settle();assert.equal(second.r.code,200);
});
