const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const pages=['obs-master','vtube-studio-master','streaming-gear','kanau','youtube-analyst','youtube-game-strategy'];
const keys=['obs-master','vtube-studio','streaming-gear','kanau','youtube-analyst','youtube-game-strategy'];
test('全ツールに入力見出しと使い方・使用例を表示し、使用例は自動送信しない',()=>{
  for(const [i,page] of pages.entries()){
    const html=fs.readFileSync(path.join(__dirname,'../views',page+'.html'),'utf8');assert.match(html,/id="thread-title">相談を入力してください/);assert.match(html,/tool-help.js/);
    const node=(tag='')=>({tag,children:[],append(...items){this.children.push(...items);},setAttribute(){}}),input={value:'',focus(){}},layout={before(n){this.help=n;}};
    const context={document:{body:{dataset:{tool:keys[i]}},querySelector:()=>layout,createElement:node,getElementById:id=>{assert.equal(id,'tool-text');return input;}},confirm:()=>false};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/tool-help.js'),'utf8'),context);
    assert.equal(layout.help.children[0].textContent,'使い方と使用例');const examples=layout.help.children.filter(n=>n.tag==='button');assert.equal(examples.length,2);examples[0].onclick();assert.ok(input.value.length>0);
    input.value='入力途中の相談';examples[1].onclick();assert.equal(input.value,'入力途中の相談');
  }
});
test('ヘッダーのツールリンクはスペシャルコンテンツ直後に並ぶ',()=>{
  for(const file of ['dashboard','special-contents','admin-contents']){
    const html=fs.readFileSync(path.join(__dirname,'../views',file+'.html'),'utf8');const nav=html.slice(html.indexOf('function buildNav'));
    assert.match(nav, /href:\s*'\/special-contents'[^\n]+\n\s*\{ href:\s*'\/tools'/);
  }
});
