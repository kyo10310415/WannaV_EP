const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
function render(text){
  function node(tag,text=''){return {tag,textContent:text,children:[],attributes:{},append(...xs){this.children.push(...xs);},setAttribute(k,v){this.attributes[k]=v;}};}
  const context={window:{},URL,document:{createElement:tag=>node(tag),createTextNode:text=>node('#text',text)}};
  vm.runInNewContext(read('public/js/tool-markdown.js'),context);
  const root=context.window.ToolMarkdown.render(text),nodes=[];function walk(n){nodes.push(n);n.children.forEach(walk);}walk(root);return nodes;
}
test('回答の見出し・強調・番号手順・入れ子・引用・コード・区切りを整形する',()=>{
 const nodes=render('## まず試してみましょう\n1. **設定**を開く\n   - `音声`を選ぶ\n2. *確認*する\n\n> 補足です\n---\n```html\n<script>alert(1)</script>\n```\n__太字__と~~取り消し~~');
 for(const tag of ['h3','strong','ol','ul','blockquote','pre','code','hr','em','del'])assert.ok(nodes.some(n=>n.tag===tag),tag);
 assert.equal(nodes.filter(n=>n.tag==='li').length,3);
 const ol=nodes.find(n=>n.tag==='ol');assert.equal(ol.attributes.start,'1');assert.ok(ol.children[0].children.some(n=>n.tag==='ul'));
 assert.equal(nodes.find(n=>n.tag==='pre').children[0].textContent,'<script>alert(1)</script>');assert.ok(!nodes.some(n=>n.tag==='script'));
});
test('危険なHTML・URLは実行せず、通常リンクと表だけを安全に表示する',()=>{
 const nodes=render('<img src=x onerror=alert(1)>\n[危険](javascript:alert(1))\n[秘密](https://user:password@example.com)\n|項目|案内|\n|---|---|\n|A|[公式](https://example.com)|');
 assert.equal(nodes.filter(n=>n.tag==='a').length,1);assert.equal(nodes.find(n=>n.tag==='a').rel,'noopener noreferrer');assert.ok(!nodes.some(n=>n.tag==='img'));assert.ok(nodes.some(n=>n.tag==='table'));
});
test('6ツールでMarkdownを読み込み、回答だけを共通レンダラーへ渡す',()=>{
 for(const file of ['obs-master','vtube-studio-master','streaming-gear','kanau','youtube-analyst','youtube-game-strategy']){
  const html=read('views/'+file+'.html');assert.ok(html.indexOf('/js/tool-markdown.js')>=0);assert.ok(html.indexOf('/js/tool-markdown.js')<html.indexOf('/js/tools.js'));
 }
 assert.match(read('public/js/tools.js'),/if\(m.role==='assistant' && window.ToolMarkdown\)/);
});
test('全ツールに丁寧で親しみのある口調を指示し、ゲームの固定初回案内は維持する',()=>{
 for(const file of ['obsMaster','vtubeStudioMaster','streamingGearConcierge','kanau','youtubeAnalyst','youtubeGameStrategy']){
  const service=require('../src/services/'+file);assert.ok(service.PROMPT.includes('やわらかく親しみのある丁寧語'));assert.ok(service.PROMPT.includes('分析の厳密さ'));
 }
 assert.ok(require('../src/services/youtubeGameStrategy').INTRO.startsWith('分析モードを選択してください。'));
});
test('太字の中にコードやリンクがあっても記号を残さず安全に表示する',()=>{
 const nodes=render('**`設定 → 音声`を開く**\n**[公式](https://example.com)**');
 const strong=nodes.find(n=>n.tag==='strong');assert.ok(strong.children.some(n=>n.tag==='code'&&n.textContent==='設定 → 音声'));
 assert.equal(nodes.filter(n=>n.tag==='a').length,1);
});
