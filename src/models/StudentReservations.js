const db = require('../config/database');
function calendar(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = type => parts.find(part=>part.type===type).value;
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const tomorrow = new Date(today+'T00:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  return {month:today.slice(0,7),tomorrow:tomorrow.toISOString().slice(0,10)};
}
async function forStudent(userId, now = new Date()) {
  const {month,tomorrow} = calendar(now);
  const test=await require('./TestStudentSettings').find(userId);
  if (test?.lessons) {
    if (!test.contract_plan || test.contract_plan==='エントリープラン') return {eligible:false};
    const lessons=test.lessons.filter(lesson=>lesson.date.startsWith(month));
    return {eligible:true,available:true,manual:true,month,lessons,count:lessons.length,
      tomorrowLessons:test.lessons.filter(lesson=>lesson.date===tomorrow),lastSyncedAt:test.updated_at};
  }
  const profile = (await db.query(`SELECT COALESCE(ns.contract_plan,sp.contract_plan) AS contract_plan,
    ns.student_number,cs.student_id,
    (SELECT COUNT(*) FROM notion_students other WHERE LOWER(other.student_number)=LOWER(ns.student_number)) AS matches
    FROM student_profiles sp LEFT JOIN notion_students ns ON ns.notion_page_id=sp.notion_page_id
    LEFT JOIN central_students cs ON cs.notion_page_id=sp.notion_page_id WHERE sp.user_id=$1`,[userId])).rows[0];
  if (!profile?.contract_plan || profile.contract_plan==='エントリープラン') return {eligible:false};
  const unavailable = {eligible:true,available:false,month};
  if (!require('../config/centralDatabase').enabled() || !profile.student_id || Number(profile.matches)!==1) return unavailable;
  const state=(await db.query('SELECT last_success FROM central_sync_state WHERE id=1')).rows[0];
  if (!state?.last_success || calendar(new Date(state.last_success)).month!==month) return unavailable;
  const rows=(await db.query(`SELECT lesson_date,lesson_time,tutor_name FROM central_reservations
    WHERE student_id=$1 AND (LEFT(lesson_date,7)=$2 OR LEFT(lesson_date,10)=$3)
    ORDER BY lesson_date,event_id`,[profile.student_id,month,tomorrow])).rows;
  const lessons=rows.map(row=>({date:row.lesson_date.slice(0,10),time:row.lesson_time || '',tutorName:row.tutor_name || ''}));
  if (lessons.some(lesson=>!/^\d{4}-\d{2}-\d{2}$/.test(lesson.date) ||
    !Number.isFinite(Date.parse(lesson.date)) || new Date(lesson.date).toISOString().slice(0,10)!==lesson.date)) return unavailable;
  const currentMonth=lessons.filter(lesson=>lesson.date.startsWith(month));
  return {eligible:true,available:true,month,lessons:currentMonth,count:currentMonth.length,
    tomorrowLessons:lessons.filter(lesson=>lesson.date===tomorrow),lastSyncedAt:state.last_success};
}
module.exports={calendar,forStudent};
