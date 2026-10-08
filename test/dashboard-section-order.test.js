const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('ダッシュボードの主要セクションは指定順で重複なく配置される',()=>{
  const html=fs.readFileSync(require.resolve('../views/dashboard.html'),'utf8');
  const ids=['portal-links','student-character-panel','student-lessons-panel','growth-roadmap','completion-rate','lessons-container'];
  let previous=-1;
  for(const id of ids) {
    const marker=`id="${id}"`,index=html.indexOf(marker);
    assert.ok(index>previous,id+'の表示順');
    assert.equal(html.indexOf(marker,index+marker.length),-1,id+'の重複');previous=index;
  }
});
