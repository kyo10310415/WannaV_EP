const db=require('../config/database');
const {TARGET_CONTRACT_PLANS}=require('../config/contractPlans');
const statuses=['アクティブ','レッスン準備中','休会','正規退会','強制退会'];
const validDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
function validate(data) {
  if (!data || typeof data.name!=='string' || !data.name.trim() || data.name.length>100 ||
    typeof data.studentNumber!=='string' || data.studentNumber.length>100 ||
    !TARGET_CONTRACT_PLANS.includes(data.contractPlan) || !statuses.includes(data.status) ||
    (data.textType!==undefined && !['新','旧'].includes(data.textType)) ||
    (data.lessonStartDate!=='' && !validDate(data.lessonStartDate)) ||
    !Array.isArray(data.lessons) || data.lessons.length>50 || data.lessons.some(row=>!row || !validDate(row.date) ||
      typeof row.time!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time) ||
      typeof row.tutorName!=='string' || row.tutorName.length>100)) return null;
  return {name:data.name.trim(),studentNumber:data.studentNumber.trim(),contractPlan:data.contractPlan,status:data.status,
    textType:data.textType || '旧',lessonStartDate:data.lessonStartDate || null,lessons:data.lessons.map(row=>({date:row.date,time:row.time,tutorName:row.tutorName.trim()}))};
}
async function find(userId=null, queryable=db) {
  return (await queryable.query(`SELECT u.id,u.name,sp.contract_plan,sp.status,sp.lesson_start_date::text,
    settings.student_number,settings.lessons,settings.updated_at,settings.text_type
    FROM users u LEFT JOIN student_profiles sp ON sp.user_id=u.id
    LEFT JOIN test_student_settings settings ON settings.user_id=u.id
    WHERE u.username='test_seito' AND u.role='生徒' AND sp.notion_page_id IS NULL
      AND ($1::integer IS NULL OR u.id=$1)`,[userId])).rows[0] || null;
}
async function save(data) {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const user=(await client.query("SELECT id FROM users WHERE username='test_seito' AND role='生徒' FOR UPDATE")).rows[0];
    if (!user) {await client.query('ROLLBACK');return false;}
    await client.query('SELECT user_id FROM student_profiles WHERE user_id=$1 FOR UPDATE',[user.id]);
    if (!await find(user.id,client)) {await client.query('ROLLBACK');return false;}
    await client.query('UPDATE users SET name=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2',[data.name,user.id]);
    await client.query(`INSERT INTO student_profiles(user_id,contract_plan,status,lesson_start_date)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET contract_plan=EXCLUDED.contract_plan,
      status=EXCLUDED.status,lesson_start_date=EXCLUDED.lesson_start_date,updated_at=CURRENT_TIMESTAMP`,
      [user.id,data.contractPlan,data.status,data.lessonStartDate]);
    await client.query(`INSERT INTO test_student_settings(user_id,student_number,lessons,text_type) VALUES($1,$2,$3::jsonb,$4)
      ON CONFLICT(user_id) DO UPDATE SET student_number=EXCLUDED.student_number,lessons=EXCLUDED.lessons,text_type=EXCLUDED.text_type,updated_at=CURRENT_TIMESTAMP`,
      [user.id,data.studentNumber,JSON.stringify(data.lessons),data.textType]);
    await client.query('COMMIT');return true;
  } catch (error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
}
module.exports={find,save,validate};
