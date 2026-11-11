const db=require('../config/database'),pricing=require('./toolPricing'),fx=require('./toolExchangeRate');
const UNAVAILABLE='現在使用できません。明日以降にお試しください。';
function limit(){const raw=process.env.TOOLS_DAILY_BUDGET_JPY??'100';if(raw==='off')return null;const n=Number(raw);if(String(raw).trim()===''||!Number.isFinite(n)||n<0)throw Object.assign(new Error('ツールの利用上限設定を確認してください。'),{status:503});return n;}
async function totals(store,day,rate,cap){return (await store.query(`SELECT
 COALESCE(sum(CASE WHEN estimated_usd IS NOT NULL THEN COALESCE(estimated_jpy,estimated_usd*COALESCE(fx_rate,$2)) ELSE 0 END),0) AS spent,
 COALESCE(sum(CASE WHEN estimated_usd IS NULL THEN CASE WHEN budget_hold_jpy>0 THEN budget_hold_jpy ELSE $3 END ELSE 0 END),0) AS held,
 count(*) FILTER(WHERE status='pending') AS pending
 FROM tool_usage WHERE created_at >= $1::date::timestamp AT TIME ZONE 'Asia/Tokyo' AND created_at < ($1::date+1)::timestamp AT TIME ZONE 'Asia/Tokyo'`,[day,rate,cap])).rows[0];}
async function summary(store=db,rateInfo){const cap=limit();if(cap===null)return {limit:null,blocked:false};const info=rateInfo||await fx.dailyRate();if(!(info.rate>0))return {limit:cap,blocked:true,reason:'為替情報を取得できません。時間をおいて再度お試しください。'};
 const total=await totals(store,info.day,info.rate,cap),spent=Number(total.spent),held=Number(total.held);return {limit:cap,spent,held,pending:Number(total.pending),day:info.day,blocked:spent+held>=cap,reason:Number(total.pending)>0&&spent<cap?'回答を処理しています。完了後にもう一度お試しください。':UNAVAILABLE};}
function requirePrices(toolKey,imageMode){const names=['TOOLS_INPUT_USD_PER_MILLION','TOOLS_CACHED_USD_PER_MILLION','TOOLS_OUTPUT_USD_PER_MILLION'];if(!imageMode&&toolKey!=='youtube-analyst')names.push('TOOLS_SEARCH_USD_PER_CALL');if(imageMode)names.push('TOOLS_IMAGE_USD_PER_CALL');if(toolKey==='youtube-game-strategy')names.push('TOOLS_CODE_INTERPRETER_USD_PER_CONTAINER');if(names.some(n=>pricing.rate(n)===null))throw Object.assign(new Error('現在使用できません。料金設定について管理者へお問い合わせください。'),{status:503});}
async function reserve(store,rateInfo,toolKey,imageMode){const cap=limit();if(cap===null)return 0;requirePrices(toolKey,imageMode);const state=await summary(store,rateInfo);if(state.blocked)throw Object.assign(new Error(state.reason),{status:429});
 // Reserve the remaining daily allowance while a request is in flight. Unknown
 // provider costs retain this hold; known costs replace it when settled.
 return Math.max(0,cap-state.spent-state.held);
}
module.exports={limit,summary,reserve,UNAVAILABLE};
