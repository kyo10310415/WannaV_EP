const router = require('express').Router();
const {auth,checkRole} = require('../middleware/auth');
const db = require('../config/database');
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
router.get('/status',auth,checkRole('管理者','セールス','クルー'),async(req,res)=>{
  try {
    res.json({enabled:require('../config/centralDatabase').enabled(),state:(await db.query('SELECT * FROM central_sync_state WHERE id=1')).rows[0] || null});
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
