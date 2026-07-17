const db = require('../config/database');

class StudentProfile {
  /**
   * 生徒プロフィールを取得（user_id から）
   */
  static async findByUserId(userId) {
    const result = await db.query(`
      SELECT
        sp.*,
        u.name AS student_name,
        u.username AS student_username,
        u.email AS student_email,
        u.created_at AS account_created_at,
        u.last_login,
        t.name AS tutor_name,
        t.username AS tutor_username,
        cb.name AS status_changed_by_name
      FROM student_profiles sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      LEFT JOIN users cb ON sp.status_changed_by = cb.id
      WHERE sp.user_id = $1
    `, [userId]);
    return result.rows[0] || null;
  }

  /**
   * 全生徒プロフィール一覧（役割: 生徒のみ）
   */
  static async getAll({ status, tutorId } = {}) {
    let whereClause = `WHERE u.role = '生徒'`;
    const params = [];

    if (status) {
      params.push(status);
      whereClause += ` AND sp.status = $${params.length}`;
    }
    if (tutorId) {
      params.push(tutorId);
      whereClause += ` AND sp.assigned_tutor_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username AS student_username,
        u.email AS student_email,
        u.created_at AS account_created_at,
        u.last_login,
        sp.id AS profile_id,
        sp.status,
        sp.status_changed_at,
        sp.status_note,
        sp.contract_plan,
        sp.contract_start_date,
        sp.contract_end_date,
        sp.lesson_start_date,
        sp.assigned_tutor_id,
        sp.goal,
        sp.notes,
        sp.handover_completed,
        sp.handover_completed_at,
        sp.notion_page_id,
        sp.updated_at AS profile_updated_at,
        t.name AS tutor_name,
        t.username AS tutor_username,
        -- 最終受講日
        MAX(up.last_watched_at) AS last_activity,
        -- 受講完了数
        COUNT(up.id) FILTER (WHERE up.completed = true) AS completed_lessons,
        -- 最新満足度スコア
        (SELECT overall_score FROM satisfaction_surveys ss WHERE ss.student_user_id = u.id ORDER BY created_at DESC LIMIT 1) AS latest_satisfaction,
        -- 延長審査中フラグ
        EXISTS(SELECT 1 FROM extension_reviews er WHERE er.student_user_id = u.id AND er.review_status = '審査中') AS under_review
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      LEFT JOIN user_progress up ON u.id = up.user_id
      ${whereClause}
      GROUP BY u.id, u.name, u.username, u.email, u.created_at, u.last_login,
               sp.id, sp.status, sp.status_changed_at, sp.status_note,
               sp.contract_plan, sp.contract_start_date, sp.contract_end_date,
               sp.lesson_start_date, sp.assigned_tutor_id, sp.goal, sp.notes,
               sp.handover_completed, sp.handover_completed_at, sp.notion_page_id, sp.updated_at,
               t.name, t.username
      ORDER BY sp.status NULLS LAST, u.created_at DESC
    `, params);
    return result.rows;
  }

  /**
   * 生徒プロフィールを作成または更新（UPSERT）
   */
  static async upsert(userId, data) {
    const {
      status, statusNote, statusChangedBy,
      contractPlan, contractStartDate, contractEndDate, lessonStartDate,
      assignedTutorId, goal, notes, notionPageId
    } = data;

    const result = await db.query(`
      INSERT INTO student_profiles
        (user_id, status, status_note, status_changed_by, status_changed_at,
         contract_plan, contract_start_date, contract_end_date, lesson_start_date,
         assigned_tutor_id, goal, notes, notion_page_id, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE SET
        status = COALESCE(EXCLUDED.status, student_profiles.status),
        status_note = COALESCE(EXCLUDED.status_note, student_profiles.status_note),
        status_changed_by = COALESCE(EXCLUDED.status_changed_by, student_profiles.status_changed_by),
        status_changed_at = CASE
          WHEN EXCLUDED.status IS DISTINCT FROM student_profiles.status
          THEN CURRENT_TIMESTAMP
          ELSE student_profiles.status_changed_at
        END,
        contract_plan = COALESCE(EXCLUDED.contract_plan, student_profiles.contract_plan),
        contract_start_date = COALESCE(EXCLUDED.contract_start_date, student_profiles.contract_start_date),
        contract_end_date = COALESCE(EXCLUDED.contract_end_date, student_profiles.contract_end_date),
        lesson_start_date = COALESCE(EXCLUDED.lesson_start_date, student_profiles.lesson_start_date),
        assigned_tutor_id = COALESCE(EXCLUDED.assigned_tutor_id, student_profiles.assigned_tutor_id),
        goal = COALESCE(EXCLUDED.goal, student_profiles.goal),
        notes = COALESCE(EXCLUDED.notes, student_profiles.notes),
        notion_page_id = COALESCE(EXCLUDED.notion_page_id, student_profiles.notion_page_id),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      userId,
      status || 'レッスン準備中',
      statusNote || null,
      statusChangedBy || null,
      contractPlan || null,
      contractStartDate || null,
      contractEndDate || null,
      lessonStartDate || null,
      assignedTutorId || null,
      goal || null,
      notes || null,
      notionPageId || null
    ]);
    return result.rows[0];
  }

  /**
   * ステータスのみ更新
   */
  static async updateStatus(userId, status, note, changedBy) {
    const result = await db.query(`
      UPDATE student_profiles
      SET status = $1,
          status_note = $2,
          status_changed_by = $3,
          status_changed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $4
      RETURNING *
    `, [status, note || null, changedBy || null, userId]);

    if (result.rows.length === 0) {
      // プロフィールが存在しない場合は作成
      return await StudentProfile.upsert(userId, { status, statusNote: note, statusChangedBy: changedBy });
    }
    return result.rows[0];
  }

  /**
   * 担当Tutorの割り当て更新
   */
  static async updateTutor(userId, tutorId) {
    const result = await db.query(`
      UPDATE student_profiles
      SET assigned_tutor_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING *
    `, [tutorId, userId]);

    if (result.rows.length === 0) {
      return await StudentProfile.upsert(userId, { assignedTutorId: tutorId });
    }
    return result.rows[0];
  }

  /**
   * 契約終了が近い生徒（延長審査対象候補）
   * daysThreshold: 何日以内に終了するか（デフォルト30日）
   */
  static async getExpiringStudents(daysThreshold = 30) {
    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username,
        sp.status,
        sp.contract_end_date,
        sp.contract_plan,
        sp.assigned_tutor_id,
        t.name AS tutor_name,
        (sp.contract_end_date - CURRENT_DATE) AS days_remaining,
        EXISTS(
          SELECT 1 FROM extension_reviews er
          WHERE er.student_user_id = u.id
            AND er.review_status IN ('審査中', '保留')
        ) AS already_under_review
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      WHERE u.role = '生徒'
        AND sp.status = 'アクティブ'
        AND sp.contract_end_date IS NOT NULL
        AND sp.contract_end_date <= CURRENT_DATE + INTERVAL '${daysThreshold} days'
        AND sp.contract_end_date >= CURRENT_DATE
      ORDER BY sp.contract_end_date ASC
    `);
    return result.rows;
  }

  /**
   * フォロー対象者（最終活動から7日以上経過したアクティブ生徒）
   */
  static async getFollowUpTargets(inactiveDays = 7) {
    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username,
        sp.status,
        sp.contract_plan,
        sp.assigned_tutor_id,
        t.name AS tutor_name,
        MAX(up.last_watched_at) AS last_activity,
        (CURRENT_DATE - MAX(up.last_watched_at)::date) AS inactive_days
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      LEFT JOIN user_progress up ON u.id = up.user_id
      WHERE u.role = '生徒'
        AND sp.status = 'アクティブ'
      GROUP BY u.id, u.name, u.username, sp.status, sp.contract_plan,
               sp.assigned_tutor_id, t.name
      HAVING MAX(up.last_watched_at) < CURRENT_TIMESTAMP - INTERVAL '${inactiveDays} days'
          OR MAX(up.last_watched_at) IS NULL
      ORDER BY last_activity ASC NULLS FIRST
    `);
    return result.rows;
  }
}

module.exports = StudentProfile;
