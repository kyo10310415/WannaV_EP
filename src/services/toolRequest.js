const {createHash}=require('crypto');
// The key identifies public, fixed instructions, never private conversation text.
function cacheKey(model,instructions,variant='text'){return 'wannav-'+createHash('sha256').update(JSON.stringify([model,instructions,variant])).digest('hex').slice(0,56);}
function attachmentTracker(){
 const seen=new Map();let duplicates=0;
 return {reference(a,location){
  const data=Buffer.from(a.data),category=['image','generated'].includes(a.kind)?'image':a.kind;
  // Tiny attachments cost less than a reference marker; keep them unchanged.
  if(data.length<1024)return null;
  const key=createHash('sha256').update(JSON.stringify([category,a.mime||''])).update(data).digest('hex');
  if(!seen.has(key)){seen.set(key,location||"前の発言");return null;}
  duplicates++;return '添付資料の再掲（内容は'+seen.get(key)+'と完全に同一）：この発言でも前に送信した同じ資料を参照してください。';
 },get duplicates(){return duplicates;}};
}
function searchChoice(messages){
 const last=messages.filter(m=>m.role==='user').at(-1);
 if(!messages.some(m=>m.role==='assistant')||!last||(last.attachments||[]).length)return 'required';
 // Only simple acknowledgements and numbered selections are candidates. Search
 // remains available, and the fixed prompts still require it for current facts.
 return /^(?:[1-9１-９①-⑩]|はい|いいえ|OK|ok|了解です|ありがとう(?:ございます|ございました)?|助かりました|解決しました|直りました|できました|試しました|変わりません|同じです|まだです)[。！!\s]*$/u.test(String(last.text||'').trim())?'auto':'required';
}
module.exports={cacheKey,attachmentTracker,searchChoice};
