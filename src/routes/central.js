const router = require('express').Router();
const {auth,checkRole} = require('../middleware/auth');
const db = require('../config/database');
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
router.get('/test-student',auth,checkRole('管理者'),async(req,res)=>{
  try {
    const data=await require('../models/TestStudentSettings').find();
    if (!data) return res.status(404).json({error:'Notion未連携のtest_seitoが見つかりません'});
    res.json(data);
  } catch (_) {res.status(503).json({error:'テスト生徒設定を取得できません'});}
});
router.put('/test-student',auth,checkRole('管理者'),async(req,res)=>{
  const model=require('../models/TestStudentSettings'),data=model.validate(req.body);
  if (!data) return res.status(400).json({error:'生徒情報・日付・時刻を確認してください（予約は最大50件）'});
  try {
    if (!await model.save(data)) return res.status(404).json({error:'Notion未連携のtest_seitoが見つかりません'});
    res.json({message:'テスト生徒情報とレッスン日を保存しました'});
  } catch (_) {res.status(503).json({error:'テスト生徒設定を保存できません'});}
});
router.get('/my-lessons',auth,checkRole('生徒'),async(req,res)=>{
  try {res.json(await require('../models/StudentReservations').forStudent(req.user.id));}
  catch (_) {res.status(503).json({error:'レッスン予約を取得できません'});}
});
router.get('/duplicates',auth,checkRole('管理者','セールス'),async(req,res)=>{
  try {
    const rows=(await db.query(`SELECT ns.student_number,ns.student_name,
      (SELECT COUNT(*)::integer FROM student_profiles sp WHERE sp.notion_page_id=ns.notion_page_id) AS account_count
      FROM notion_students ns WHERE LOWER(ns.student_number) IN (
        SELECT LOWER(student_number) FROM notion_students WHERE student_number IS NOT NULL AND student_number<>''
        GROUP BY LOWER(student_number) HAVING COUNT(*)>1)
      ORDER BY LOWER(ns.student_number),ns.student_name`)).rows;
    res.json({duplicates:rows,duplicateNumbers:new Set(rows.map(row=>row.student_number.toLowerCase())).size});
  } catch (_) {res.status(503).json({error:'学籍番号の重複を取得できません'});}
});
router.get('/status',auth,checkRole('管理者','セールス','クルー'),async(req,res)=>{
  try {
    res.json({enabled:require('../config/centralDatabase').enabled(),state:(await db.query('SELECT * FROM central_sync_state WHERE id=1')).rows[0] || null,
      sync:require('../services/centralStudentSync').getStatus()});
  } catch (_) {res.status(503).json({error:'同期状況を取得できません'});}
});
router.get('/reservations',auth,checkRole('管理者','セールス','クルー'),async(req,res)=>{
  try {
    const studentId=typeof req.query.studentId === 'string' ? req.query.studentId.trim() : '';
    if (!studentId || studentId.length>255) return res.status(400).json({error:'学籍番号が必要です'});
    const student=(await db.query(`SELECT cs.student_id,sp.assigned_tutor_id FROM central_students cs
      LEFT JOIN student_profiles sp ON sp.notion_page_id=cs.notion_page_id WHERE cs.student_id=$1`,[studentId])).rows[0];
    if(!student) return res.status(404).json({error:'中央管理の生徒情報がありません'});
    if(req.user.role==='クルー' && student.assigned_tutor_id!==req.user.id) return res.status(403).json({error:'アクセス権限がありません'});
    const limit=50,offset=Math.max(0,parseInt(req.query.offset,10)||0);
    const rows=(await db.query(`SELECT *,COUNT(*) OVER()::integer AS total_count FROM central_reservations
      WHERE student_id=$1 ORDER BY lesson_date,event_id LIMIT $2 OFFSET $3`,[studentId,limit,offset])).rows;
    res.json({reservations:rows,total:rows[0]?.total_count || 0,limit,offset});
  } catch (_) {res.status(503).json({error:'予約状況を取得できません'});}
});
module.exports=router;
