const db = require('../config/database');
const sheet = require('../utils/paymentSheet');
const { paymentEnabled } = require('../config/portal');

// Same date precedence as the existing student directory. No name/login-ID fallback.
const STUDENT_SQL = `
  SELECT u.id AS user_id, NULLIF(TRIM(ns.student_number), '') AS student_number,
    COALESCE(ns.lesson_start_month, sp.lesson_start_date)::text AS lesson_start_date
  FROM users u
  LEFT JOIN student_profiles sp ON sp.user_id = u.id
  LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
  WHERE u.role = '生徒'`;

function decideAccess({ enabled, role, today, student, state, payment, month }) {
  if (!enabled || role !== '生徒') return { allowed: true, reason: 'not_enforced' };
  if (student?.lesson_start_date && today < student.lesson_start_date) {
    return { allowed: true, reason: 'before_start' };
  }
  if (!state?.last_success_at || state.payment_month !== month) {
    return { allowed: true, reason: 'awaiting_month_sync' };
  }
  if (!student?.lesson_start_date) return { allowed: true, reason: 'missing_lesson_start_date' };
  if (!student.student_number) return { allowed: true, reason: 'missing_student_number' };
  if (!payment || payment.student_number !== student.student_number) {
    return { allowed: true, reason: 'awaiting_student_sync' };
  }
  return { allowed: payment.is_paid === true, reason: payment.is_paid ? 'paid' : 'payment_required' };
}

class StudentPayment {
  static async getAccess(userId, role) {
    if (!paymentEnabled() || role !== '生徒') return { allowed: true, reason: 'not_enforced' };
    const result = await StudentPayment.getDetail(userId, false);
    return result?.access || { allowed: false, reason: 'student_not_found' };
  }

  static async getDetail(userId, includeIssues = true) {
    const month = sheet.previousMonth();
    const result = await db.query(`
      WITH student AS (${STUDENT_SQL} AND u.id = $1)
      SELECT s.*,
        p.payment_status, p.is_paid, p.synced_at, p.sync_error,
        p.student_number AS payment_student_number,
        st.last_success_at, st.payment_month::text AS synced_month,
        st.last_attempt_at, st.last_error, ${includeIssues ? 'st.issues' : "'[]'::jsonb AS issues"}
      FROM student s
      LEFT JOIN student_payment_status p ON p.user_id = s.user_id AND p.payment_month = $2::date AND p.source_key = $3
      LEFT JOIN payment_sync_state st ON st.source_key = $3
    `, [userId, month, sheet.sourceKey()]);
    const row = result.rows[0];
    if (!row) return null;
    const state = { ...row, payment_month: row.synced_month };
    const payment = row.synced_at ? { ...row, student_number: row.payment_student_number } : null;
    // Duplicate rows retain the last good decision for this same source and month.
    const duplicate = Array.isArray(row.issues) && row.issues.some(issue =>
      issue.user_id === row.user_id && issue.code === 'duplicate');
    return { ...row, issues: undefined, payment_month: month,
      access: decideAccess({ enabled: paymentEnabled(), role: '生徒', today: sheet.japanDate(),
        student: row, state, payment, month }),
      issue: duplicate ? 'duplicate' : row.sync_error || (!row.student_number ? 'missing_student_number' : null) };
  }

  static async synchronize(fetchRows = sheet.fetchPaymentRows) {
    const client = await db.pool.connect();
    let locked = false;
    const source = sheet.sourceKey();
    try {
      // Dedicated session lock prevents overlapping syncs across Render processes.
      locked = (await client.query('SELECT pg_try_advisory_lock(78234, 1) AS locked')).rows[0].locked;
      if (!locked) return { skipped: true };
      const month = sheet.previousMonth();
      const parsed = sheet.parsePaymentRows(await fetchRows(), month);
      await client.query('BEGIN');
      const students = (await client.query(STUDENT_SQL)).rows;
      const updates = [];
      const issues = [];
      const counts = new Map();
      for (const s of students) if (s.student_number) counts.set(s.student_number, (counts.get(s.student_number) || 0) + 1);
      for (const s of students) {
        let code = null;
        if (!s.student_number) code = 'missing_student_number';
        else if (parsed.duplicates.has(s.student_number) || counts.get(s.student_number) > 1) code = 'duplicate';
        if (code) { issues.push({ user_id: s.user_id, code }); continue; }
        const record = parsed.records.get(s.student_number);
        if (!record) issues.push({ user_id: s.user_id, code: 'not_found' });
        if (!s.lesson_start_date) issues.push({ user_id: s.user_id, code: 'missing_lesson_start_date' });
        updates.push({ user_id: s.user_id, student_number: s.student_number,
          payment_status: record?.payment_status ?? 'not_found',
          is_paid: record?.is_paid ?? false, source_row: record?.source_row ?? null,
          sync_error: record ? null : 'not_found' });
      }
      await client.query(`
        INSERT INTO student_payment_status
          (user_id, student_number, payment_month, payment_status, is_paid, source_row, sync_error, synced_at, source_key)
        SELECT user_id, student_number, $2::date, payment_status, is_paid, source_row, sync_error, CURRENT_TIMESTAMP, $3
        FROM jsonb_to_recordset($1::jsonb) AS x(user_id integer, student_number text,
          payment_status text, is_paid boolean, source_row integer, sync_error text)
        ON CONFLICT (user_id, payment_month) DO UPDATE SET
          student_number = EXCLUDED.student_number, payment_status = EXCLUDED.payment_status,
          is_paid = EXCLUDED.is_paid, source_row = EXCLUDED.source_row,
          sync_error = EXCLUDED.sync_error, synced_at = EXCLUDED.synced_at, source_key = EXCLUDED.source_key
      `, [JSON.stringify(updates), month, source]);
      await client.query(`
        INSERT INTO payment_sync_state (source_key, payment_month, last_success_at, last_attempt_at, issues)
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3::jsonb)
        ON CONFLICT (source_key) DO UPDATE SET payment_month = EXCLUDED.payment_month,
          last_success_at = EXCLUDED.last_success_at, last_attempt_at = EXCLUDED.last_attempt_at,
          last_error = NULL, issues = EXCLUDED.issues
      `, [source, month, JSON.stringify(issues)]);
      await client.query('COMMIT');
      return { updated: updates.length, issues };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // Store a sanitized error code, never an Axios config/token or sheet content.
      const code = ['missing_month_header', 'duplicate_month_header', 'empty_payment_sheet'].includes(error.message)
        ? error.message : 'payment_sync_failed';
      await client.query(`
        INSERT INTO payment_sync_state (source_key, last_attempt_at, last_error)
        VALUES ($1, CURRENT_TIMESTAMP, $2)
        ON CONFLICT (source_key) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at, last_error = EXCLUDED.last_error
      `, [source, code]).catch(() => {});
      throw new Error(code);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(78234, 1)').catch(() => {});
      client.release();
    }
  }

  static async syncStatus() {
    const result = await db.query(`SELECT payment_month::text, last_success_at, last_attempt_at, last_error, issues
      FROM payment_sync_state WHERE source_key = $1`, [sheet.sourceKey()]);
    return { enabled: paymentEnabled(), configured: Boolean(process.env.GOOGLE_PAYMENT_SPREADSHEET_ID),
      target_month: sheet.previousMonth(), ...(result.rows[0] || {}) };
  }
}

module.exports = StudentPayment;
module.exports.decideAccess = decideAccess;
