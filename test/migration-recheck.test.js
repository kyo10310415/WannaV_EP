const test=require('node:test');
const assert=require('node:assert/strict');

test('69本移行済み状態の再実行・dry-runは読み取りのみ、二重upload・削除なし',async()=>{
  const db=require('../src/config/database'),storage=require('../src/services/objectStorage');
  const {migrate}=require('../scripts/migrate-media-to-object-storage');
  const original={query:db.query,enabled:storage.enabled,upload:storage.upload,remove:storage.remove};
  const queries=[];
  db.query=async sql=>{queries.push(sql);return {rows:Array.from({length:69},(_,i)=>({id:i+1,
    content_type:'video',video_url:'/uploads/video-'+i+'.mp4',video_filename:'video-'+i+'.mp4',
    video_storage_key:'lessons/video/existing-'+i+'.mp4'}))};};
  storage.enabled=()=>true;
  storage.upload=async()=>assert.fail('must not upload');storage.remove=async()=>assert.fail('must not delete');
  try {
    for(const apply of [false,true,true]) {
      const result=await migrate({apply,log(){},root:'intentionally-nonexistent'});
      assert.deepEqual(result,{migrated:0,skipped:69,failed:0,deleted:0,dryRun:!apply});
    }
    assert.equal(queries.length,3);assert.ok(queries.every(sql=>sql==='SELECT * FROM lessons ORDER BY id'));
  } finally {Object.assign(db,{query:original.query});Object.assign(storage,{enabled:original.enabled,upload:original.upload,remove:original.remove});}
});
