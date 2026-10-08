const source = require('../config/centralDatabase');
const db = require('../config/database');
const NotionStudent = require('../models/NotionStudent');
const { TARGET_CONTRACT_PLANS } = require('../config/contractPlans');
const {CentralSyncError,classify} = require('../utils/centralSyncError');
let active;
const syncStatus = {running:false,startedAt:null,lastError:null};
const normalizedPage = value => String(value || '').replace(/-/g, '').toLowerCase();

// Curated mapping is the only place to add future source fields. Never copy payment or credentials.
function mapStudents(rows, existing) {
  const seen = new Set(), pages = new Set();
  return rows.map(row => {
    const number = String(row.student_id || '').trim();
    if (!number || seen.has(number.toLowerCase()) || !row.name) throw new CentralSyncError('INVALID_STUDENT','student_mapping');
    seen.add(number.toLowerCase());
    const matches = existing.filter(e => normalizedPage(e.notion_page_id) === normalizedPage(row.notion_page_id) && row.notion_page_id
      || String(e.student_number || '').toLowerCase() === number.toLowerCase());
    if (matches.length > 1) throw new CentralSyncError('AMBIGUOUS_STUDENT','student_mapping');
    const notionPageId = matches[0]?.notion_page_id || row.notion_page_id || `central:${number}`;
    const pageKey = notionPageId.startsWith('central:') ? notionPageId : normalizedPage(notionPageId);
    if (pages.has(pageKey)) throw new CentralSyncError('DUPLICATE_PAGE','student_mapping');
    pages.add(pageKey);
    if (row.lesson_start_date) {
      const date = new Date(row.lesson_start_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.lesson_start_date) || !Number.isFinite(date.getTime())
          || date.toISOString().slice(0,10) !== row.lesson_start_date) throw new CentralSyncError('INVALID_DATE','student_mapping');
    }
    return { notionPageId, studentName:row.name, studentNumber:number, loginId:number,
      nameFurigana:matches[0]?.name_furigana || null, notionUrl:row.notion_url || null,
      status:row.status || null, contractPlan:row.contract_plan || null, lessonStartMonth:row.lesson_start_date || null,
      xUsername:row.x_account_id?.trim().replace(/^@/,'') || null, youtubeChannelId:row.youtube_channel_id?.trim() || null,
      rawData:{source:'central',studentId:number,homeroomTutor:row.homeroom_tutor || null} };
  });
}

async function run() {
  let stage='source_snapshot';
  syncStatus.running=true;syncStatus.startedAt=new Date().toISOString();syncStatus.lastError=null;
  console.info('Central student sync started');
  try {
    const {students,tutors,reservations} = await source.snapshot();
    // Empty/invalid snapshot is not a deletion instruction; preserve the previous cache.
    if (!students.length) throw new CentralSyncError('EMPTY_STUDENTS','source_validation');
    const events = new Set();
    for (const reservation of reservations) {
      if (!reservation.calendar_event_id || !reservation.student_id || !reservation.lesson_date || events.has(reservation.calendar_event_id)) throw new CentralSyncError('INVALID_RESERVATION','source_validation');
      events.add(reservation.calendar_event_id);
    }
    stage='local_students_read';
    const existing = (await db.query('SELECT notion_page_id,student_number,name_furigana FROM notion_students')).rows;
    const entries = mapStudents(students,existing);
    stage='student_accounts_save';
    const summary = await NotionStudent.upsertMany(entries, { targetPlansOnly:true });
    stage='local_cache_connect';
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      stage='student_cache_save';
      const payload = entries.map(entry => ({student_id:entry.studentNumber,notion_page_id:entry.notionPageId,
        tutor_name:entry.rawData.homeroomTutor}));
      await client.query('DELETE FROM central_students WHERE NOT (student_id=ANY($1::text[]))',[entries.map(e=>e.studentNumber)]);
      await client.query(`INSERT INTO central_students (student_id,notion_page_id,tutor_name,synced_at)
        SELECT student_id,notion_page_id,tutor_name,CURRENT_TIMESTAMP FROM jsonb_to_recordset($1::jsonb)
        AS x(student_id text,notion_page_id text,tutor_name text)
        ON CONFLICT(student_id) DO UPDATE SET notion_page_id=EXCLUDED.notion_page_id,tutor_name=EXCLUDED.tutor_name,synced_at=CURRENT_TIMESTAMP`,[JSON.stringify(payload)]);
      stage='tutor_assignment';
      const staff = (await client.query("SELECT id,email FROM users WHERE role IN ('クルー','管理者','セールス')")).rows;
      const assignments = entries.map(entry => {
        const name=entry.rawData.homeroomTutor;
        const emails = new Set(tutors.filter(t=> name && [t.notion_name,t.name,t.tutor_name].includes(name)).map(t=>t.email?.toLowerCase()).filter(Boolean));
        const matched=staff.filter(user=>emails.has(user.email.toLowerCase()));
        return {notion_page_id:entry.notionPageId,tutor_id:matched.length === 1 ? matched[0].id : null};
      });
      await client.query(`UPDATE student_profiles sp SET assigned_tutor_id=x.tutor_id
        FROM jsonb_to_recordset($1::jsonb) AS x(notion_page_id text,tutor_id integer)
        WHERE sp.notion_page_id=x.notion_page_id`,[JSON.stringify(assignments)]);
      await client.query(`UPDATE notion_students SET status='同期対象外'
        WHERE NOT (notion_page_id=ANY($1::text[])) AND COALESCE(raw_data->>'source','')<>'notion_pending'`,[entries.map(e=>e.notionPageId)]);
      // Reservation cache replacement is atomic. No operation touches source lessons or portal lesson_schedules.
      stage='reservation_cache_save';
      await client.query('DELETE FROM central_reservations');
      for (let start=0;start<reservations.length;start+=200) {
        await client.query(`INSERT INTO central_reservations(event_id,student_id,tutor_name,lesson_date,lesson_time,title)
          SELECT calendar_event_id,student_id,tutor_name,lesson_date,lesson_time,title FROM jsonb_to_recordset($1::jsonb)
          AS x(calendar_event_id text,student_id text,tutor_name text,lesson_date text,lesson_time text,title text)`,
        [JSON.stringify(reservations.slice(start,start+200))]);
      }
      stage='sync_state_save';
      await client.query(`INSERT INTO central_sync_state(id,last_success,student_count,reservation_count)
        VALUES(1,CURRENT_TIMESTAMP,$1,$2) ON CONFLICT(id) DO UPDATE SET last_success=CURRENT_TIMESTAMP,
        student_count=EXCLUDED.student_count,reservation_count=EXCLUDED.reservation_count`,[students.length,reservations.length]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>{});throw classify(error,stage); }
    finally {client.release();}
    console.info('Central student sync completed', {students:summary.upserted,reservations:reservations.length});
    return {synced:summary.upserted,...summary,reservations:reservations.length,timestamp:new Date()};
  } catch (error) {
    const safe=classify(error,stage);
    syncStatus.lastError={code:safe.code,stage:safe.stage,message:safe.message,at:new Date().toISOString()};
    console.error('Central student sync failed', syncStatus.lastError);
    throw safe;
  } finally {syncStatus.running=false;}
}
function synchronize() {
  if (!source.enabled()) return Promise.reject(new Error('中央管理DB連携は無効です'));
  if (!active) active=require('../utils/studentSyncQueue')(run).finally(()=>{active=null;});
  return active;
}
module.exports = {synchronize,mapStudents,getStatus:()=>({...syncStatus,lastError:syncStatus.lastError ? {...syncStatus.lastError} : null})};
