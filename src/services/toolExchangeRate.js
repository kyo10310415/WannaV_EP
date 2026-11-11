const db=require('../config/database'),pricing=require('./toolPricing');
const pending=new Map();
const dayOf=(now=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const autoEnabled=()=>process.env.TOOLS_FX_AUTO_ENABLED!=='false';
const rowValue=row=>row?{day:String(row.day).slice(0,10),rate:Number(row.rate),source:row.source,sourceDate:String(row.source_date).slice(0,10)}:null;
async function dailyRate({day=dayOf(),transport=fetch,store=db}={}){
 if(!autoEnabled())return {day,rate:pricing.exchangeRate(),source:'configured',sourceDate:day};
 const key=day;if(pending.has(key))return pending.get(key);
 const work=(async()=>{
  const saved=(await store.query('SELECT day::text,rate,source,source_date::text FROM tool_exchange_rates WHERE day=$1',[day])).rows[0];if(saved)return rowValue(saved);
  let rate,source='frankfurter',sourceDate;
  try{
   const response=await transport('https://api.frankfurter.dev/v2/rate/usd/jpy',{signal:AbortSignal.timeout(7000)});if(!response.ok)throw new Error('FX_HTTP');
   const data=await response.json();rate=data.rate;sourceDate=data.date;
   if(data.base!=='USD'||data.quote!=='JPY'||typeof rate!=='number'||!Number.isFinite(rate)||rate<=0||rate>10000||!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)||sourceDate>day||Date.parse(day)-Date.parse(sourceDate)>7*86400000)throw new Error('FX_INVALID');
  }catch(_){
   const previous=(await store.query("SELECT day::text,rate,source,source_date::text FROM tool_exchange_rates WHERE day<$1 AND source_date >= $1::date-7 ORDER BY day DESC LIMIT 1",[day])).rows[0];
   if(!previous)throw Object.assign(new Error('為替情報を取得できません。時間をおいて再度お試しください。'),{status:503});
   rate=Number(previous.rate);sourceDate=String(previous.source_date).slice(0,10);source='carry_forward';
  }
  await store.query('INSERT INTO tool_exchange_rates(day,rate,source,source_date) VALUES($1,$2,$3,$4) ON CONFLICT(day) DO NOTHING',[day,rate,source,sourceDate]);
  return rowValue((await store.query('SELECT day::text,rate,source,source_date::text FROM tool_exchange_rates WHERE day=$1',[day])).rows[0]);
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
module.exports={dayOf,autoEnabled,dailyRate};
