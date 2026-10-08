const { Pool } = require('pg');
const {CentralSyncError,classify} = require('../utils/centralSyncError');
let pool;
const enabled = () => process.env.CENTRAL_STUDENT_SYNC_ENABLED === 'true';
function getPool() {
  if (!enabled() || !process.env.CENTRAL_DATABASE_URL) throw new CentralSyncError('CONFIG_MISSING','configuration');
  if (process.env.CENTRAL_DATABASE_URL === process.env.DATABASE_URL) throw new CentralSyncError('CONFIG_SAME_DATABASE','configuration');
  if (!pool) {
    pool = new Pool({
    connectionString: process.env.CENTRAL_DATABASE_URL,
    ssl: process.env.CENTRAL_DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 60000, query_timeout: 65000,
    options: '-c default_transaction_read_only=on', application_name: 'wannav-portal-readonly',
    });
    pool.on('error', () => console.error('Central database idle connection error'));
  }
  return pool;
}
async function snapshot() {
  let client, stage='source_connect';
  try {
    client = await getPool().connect();
    stage='source_transaction';
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
    stage='source_students';
    const students = (await client.query(`SELECT student_id,name,status,contract_plan,homeroom_tutor,
      notion_page_id,notion_url,
      lesson_start_date::text AS lesson_start_date,
      x_account_id,youtube_channel_id FROM students ORDER BY student_id`)).rows;
    stage='source_tutors';
    const tutors = (await client.query('SELECT notion_name,name,tutor_name,email FROM tutors')).rows;
    stage='source_reservations';
    const reservations = (await client.query(`SELECT calendar_event_id,student_id,tutor_name,
      lesson_date::text,lesson_time,title FROM lessons
      WHERE lesson_date >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo') ORDER BY lesson_date`)).rows;
    stage='source_commit';
    await client.query('COMMIT');
    return { students, tutors, reservations };
  } catch (error) {
    if(client) await client.query('ROLLBACK').catch(() => {});
    throw classify(error,stage);
  } finally { client?.release(); }
}
module.exports = { enabled, getPool, snapshot };
