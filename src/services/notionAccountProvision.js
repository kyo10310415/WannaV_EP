const db = require('../config/database');
const NotionStudent = require('../models/NotionStudent');
const {TARGET_CONTRACT_PLANS} = require('../config/contractPlans');
const serialize = require('../utils/studentSyncQueue');
let active;
const pageKey = id => String(id || '').replace(/-/g,'').toLowerCase();

async function run() {
  // Do not dispatch to syncNotionStudents: it refreshes the central DB when enabled.
  const students = await require('../utils/notionSync').fetchTargetPlanStudents();
  const existing = (await db.query(`SELECT ns.notion_page_id,ns.student_number,ns.login_id,ns.student_name,ns.contract_plan,
    EXISTS(SELECT 1 FROM student_profiles sp JOIN users u ON u.id=sp.user_id AND u.role='生徒'
      WHERE sp.notion_page_id=ns.notion_page_id) AS has_account FROM notion_students ns`)).rows;
  const counts = new Map();
  for(const student of students) {
    const number=student.studentNumber?.trim().toLowerCase();
    if(number) counts.set(number,(counts.get(number)||0)+1);
  }
  const entries=[], retry=[], seen=new Set();let skipped=0;
  for(const student of students) {
    const number=student.studentNumber?.trim();
    if(!number || counts.get(number.toLowerCase())!==1 || seen.has(pageKey(student.notionPageId))) {skipped++;continue;}
    seen.add(pageKey(student.notionPageId));
    const matches=existing.filter(row=>pageKey(row.notion_page_id)===pageKey(student.notionPageId)
      || row.student_number?.trim().toLowerCase()===number.toLowerCase());
    if(matches.length>1) {skipped++;continue;}
    const match=matches[0];
    if(match) {
      // Existing central fields and manual login IDs are authoritative, never overwrite them from Notion.
      if(!match.has_account && TARGET_CONTRACT_PLANS.includes(match.contract_plan)) retry.push(match);
      else skipped++;
    } else entries.push({...student,studentNumber:number,loginId:number,rawData:{...student.rawData,source:'notion_pending'}});
  }
  const summary=await NotionStudent.upsertMany(entries,{targetPlansOnly:true,insertOnly:true});
  summary.accountsSkipped+=skipped;
  for(const row of retry) {
    const result=await NotionStudent.provisionAccount({notionPageId:row.notion_page_id,loginId:row.login_id,studentName:row.student_name});
    if(result.status==='created')summary.accountsCreated++;
    else if(result.status==='linked')summary.accountsLinked++;
    else summary.accountsSkipped++;
  }
  return {...summary,synced:summary.upserted,timestamp:new Date()};
}
function provision() {
  if(!active) active=serialize(run).finally(()=>{active=null;});
  return active;
}
module.exports={provision};
