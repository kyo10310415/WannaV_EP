const db=require('../config/database');
const {calendar}=require('./StudentReservations');
const GOALS=Object.freeze([
  [0,0],[0,0],[100,0],[250,0],[500,0],[750,25],[1000,50],[1250,75],[1500,100],
  [1750,125],[2000,150],[2150,250],[2300,350],[2450,450],[2600,550],[2800,650],[3000,700],[3500,800]
].map(([x,youtube],index)=>Object.freeze({month:index+1,x,youtube})));
function currentMonth(start,now=new Date()) {
  if (typeof start!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0,10)!==start) return null;
  const month=calendar(now).month;
  return (Number(month.slice(0,4))-Number(start.slice(0,4)))*12+Number(month.slice(5,7))-Number(start.slice(5,7))+1;
}
function latestMetric(metric) {
  if (!metric) return {count:null,fetchedAt:null};
  const points=[...(metric.history || [])];
  if (metric.status==='ok' && metric.count!==null) points.push({count:metric.count,fetchedAt:metric.fetchedAt});
  const latest=points.filter(p=>Number.isSafeInteger(p.count) && p.count>=0 && Number.isFinite(Date.parse(p.fetchedAt)))
    .sort((a,b)=>new Date(b.fetchedAt)-new Date(a.fetchedAt))[0];
  return latest ? {count:latest.count,fetchedAt:latest.fetchedAt} : {count:null,fetchedAt:null};
}
async function forStudent(userId,now=new Date()) {
  const profile=(await db.query(`SELECT sp.notion_page_id,COALESCE(ns.contract_plan,sp.contract_plan) AS contract_plan,
    CASE WHEN ns.raw_data->>'source'='central' THEN ns.raw_data->>'textType' ELSE settings.text_type END AS text_type,
    to_char(COALESCE(ns.lesson_start_month,sp.lesson_start_date),'YYYY-MM-DD') AS start_date
    FROM student_profiles sp JOIN users u ON u.id=sp.user_id
    LEFT JOIN notion_students ns ON ns.notion_page_id=sp.notion_page_id
    LEFT JOIN test_student_settings settings ON settings.user_id=u.id AND u.username='test_seito' AND sp.notion_page_id IS NULL
    WHERE sp.user_id=$1 AND u.role='生徒'`,[userId])).rows[0];
  if (profile?.text_type!=='新' || !['スタンダードプラン','生徒プラン'].includes(profile?.contract_plan)) return {eligible:false};
  const month=currentMonth(profile.start_date,now);
  if (month===null || month<1 || month>5) return {eligible:false};
  const {SocialMetrics}=require('./SocialMetrics');
  const metrics=profile.notion_page_id ? await SocialMetrics.forPage(profile.notion_page_id,now) : await SocialMetrics.forUser(userId,now);
  return {eligible:true,currentMonth:month,goals:GOALS,current:{x:latestMetric(metrics?.platforms.x),youtube:latestMetric(metrics?.platforms.youtube)}};
}
module.exports={GOALS,currentMonth,latestMetric,forStudent};
