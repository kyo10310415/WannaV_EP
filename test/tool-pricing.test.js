const test=require('node:test'),assert=require('node:assert/strict');
const pricing=require('../src/services/toolPricing');
const rates={TOOLS_INPUT_USD_PER_MILLION:'0.75',TOOLS_CACHED_USD_PER_MILLION:'0.075',TOOLS_OUTPUT_USD_PER_MILLION:'4.5',TOOLS_SEARCH_USD_PER_CALL:'0.01',TOOLS_IMAGE_USD_PER_CALL:'0.10',TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER:'0.03',TOOLS_USD_TO_JPY:'150'};
const usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:200}};
async function withRates(fn){const before={...process.env};try{Object.assign(process.env,rates);await fn();}finally{process.env=before;}}
test('文章・キャッシュ・検索・画像の設定平均額を分けて加算し円に換算する',()=>withRates(()=>{
 const cost=pricing.estimate({usage,searches:2,imageCalls:1,imageModel:'gpt-image-2',imageSize:'1024x1024'});
 assert.ok(Math.abs(cost.usd-0.121065)<1e-10);assert.equal(cost.details.image_method,'configured_average');assert.equal(cost.details.image_size,'1024x1024');assert.ok(Math.abs(pricing.jpy(cost.usd)-18.15975)<1e-8);
}));
test('検索・画像を呼ばない確認質問にその追加料金を加算しない',()=>withRates(()=>{
 delete process.env.TOOLS_SEARCH_USD_PER_CALL;delete process.env.TOOLS_IMAGE_USD_PER_CALL;
 assert.ok(Math.abs(pricing.estimate({usage}).usd-0.001065)<1e-10);
}));
test('未設定・空欄・不正値・未知の使用量を0円としない。算出できた費用は残す',()=>withRates(()=>{
 for(const invalid of ['', ' ', '-1', 'NaN','Infinity']){process.env.TOOLS_IMAGE_USD_PER_CALL=invalid;const c=pricing.estimate({usage,imageCalls:1});assert.equal(c.usd,null);assert.ok(c.details.known_usd>0);}
 assert.equal(pricing.estimate({usageKnown:false}).usd,null);
 assert.equal(pricing.estimate({usage:{...usage,input_tokens_details:{cached_tokens:1001}}}).usd,null);
 delete process.env.TOOLS_USD_TO_JPY;assert.equal(pricing.jpy(1),null);process.env.TOOLS_USD_TO_JPY='0';assert.equal(pricing.exchangeRate(),null);
}));
test('CSV計算コンテナはツール呼び出し数ではなく新規作成数で加算する',()=>withRates(()=>{
 const c=pricing.estimate({usage,containers:1});assert.ok(Math.abs(c.usd-0.031065)<1e-10);
 const partial=pricing.estimate({usage,usageKnown:false,partialUsage:true,containers:1});assert.equal(partial.usd,null);assert.ok(Math.abs(partial.details.known_usd-0.031065)<1e-10);
}));
test('かなうさん・YouTube画像作成は画像呼び出しがある時だけ平均額を加算する',()=>withRates(async()=>{
 Object.assign(process.env,{OPENAI_API_KEY:'dummy',OPENAI_OBS_MODEL:'gpt-5.4-mini',OPENAI_KANAU_IMAGE_MODEL:'gpt-image-2'});
 const kanau=require('../src/services/kanau'),analyst=require('../src/services/youtubeAnalyst');
 const image=Buffer.from('RIFF0000WEBPfake'),messages=[{role:'user',text:'希望',metadata:{mode:'thumbnail'},attachments:[{kind:'image',mime:'image/webp',data:image}]}];
 const reply=hasImage=>async()=>({ok:true,json:async()=>({status:'completed',usage,output:hasImage?[{type:'image_generation_call',status:'completed',result:image.toString('base64')}]:[{type:'message',content:[{type:'output_text',text:'動画の内容を教えてくださいね'}]}]})});
 for(const service of [kanau,analyst]){const c=await service.answer(messages,reply(true));assert.ok(Math.abs(c.usd-0.101065)<1e-10);assert.equal(c.costDetails.image_method,'configured_average');}
 const question=await analyst.answer(messages,reply(false));assert.equal(question.imageCalls,0);assert.ok(Math.abs(question.usd-0.001065)<1e-10);
}));
