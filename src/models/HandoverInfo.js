const db = require('../config/database');

class HandoverInfo {
  /**
   * 引き継ぎ情報を作成または更新（UPSERT）
   */
  static async upsert(studentUserId, data) {
    const {
      salesUserId, tutorUserId,
      contractPlan, contractStartDate, contractEndDate,
      lessonStartDate, firstSessionDate,
      studentGoal, studentBackground, specialNotes
    } = data;

    const result = await db.query(`
      INSERT INTO handover_info
        (student_user_id, sales_user_id, tutor_user_id,
         contract_plan, contract_start_date, contract_end_date,
         lesson_start_date, first_session_date,
         student_goal, student_background, special_notes,
         status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', CURRENT_TIMESTAMP)
      ON CONFLICT (student_user_id) DO UPDATE SET
        sales_user_id = COALESCE(EXCLUDED.sales_user_id, handover_info.sales_user_id),
        tutor_user_id = COALESCE(EXCLUDED.tutor_user_id, handover_info.tutor_user_id),
        contract_plan = COALESCE(EXCLUDED.contract_plan, handover_info.contract_plan),
        contract_start_date = COALESCE(EXCLUDED.contract_start_date, handover_info.contract_start_date),
        contract_end_date = COALESCE(EXCLUDED.contract_end_date, handover_info.contract_end_date),
        lesson_start_date = COALESCE(EXCLUDED.lesson_start_date, handover_info.lesson_start_date),
        first_session_date = COALESCE(EXCLUDED.first_session_date, handover_info.first_session_date),
        student_goal = COALESCE(EXCLUDED.student_goal, handover_info.student_goal),
        student_background = COALESCE(EXCLUDED.student_background, handover_info.student_background),
        special_notes = COALESCE(EXCLUDED.special_notes, handover_info.special_notes),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      studentUserId,
      salesUserId || null,
      tutorUserId || null,
      contractPlan || null,
      contractStartDate || null,
      contractEndDate || null,
      lessonStartDate || null,
      firstSessionDate || null,
      studentGoal || null,
      studentBackground || null,
      specialNotes || null
    ]);
    return result.rows[0];
  }

  /**
   * 引き継ぎを「提出済み」に変更
   */
  static async submit(studentUserId) {
    const result = await db.query(`
      UPDATE handover_info
      SET status = 'submitted',
          submitted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE student_user_id = $1
      RETURNING *
    `, [studentUserId]);
    return result.rows[0];
  }

  /**
   * 引き継ぎを「確認済み」に変更（Tutorが確認）
   */
  static async confirm(studentUserId, confirmedBy) {
    const result = await db.query(`
      UPDATE handover_info
      SET status = 'confirmed',
          confirmed_at = CURRENT_TIMESTAMP,
          confirmed_by = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE student_user_id = $2
      RETURNING *
    `, [confirmedBy, studentUserId]);

    // student_profiles の handover_completed を true に
    if (result.rows.length > 0) {
      await db.query(`
        UPDATE student_profiles
        SET handover_completed = true,
            handover_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
      `, [studentUserId]);
    }

    return result.rows[0];
  }

  /**
   * 特定生徒の引き継ぎ情報を取得
   */
  static async findByStudentId(studentUserId) {
    const result = await db.query(`
      SELECT
        h.*,
        s.name AS student_name,
        s.username AS student_username,
        s.email AS student_email,
        sl.name AS sales_name,
        t.name AS tutor_name,
        t.username AS tutor_username,
        cb.name AS confirmed_by_name
      FROM handover_info h
      JOIN users s ON h.student_user_id = s.id
      LEFT JOIN users sl ON h.sales_user_id = sl.id
      LEFT JOIN users t ON h.tutor_user_id = t.id
      LEFT JOIN users cb ON h.confirmed_by = cb.id
      WHERE h.student_user_id = $1
    `, [studentUserId]);
    return result.rows[0] || null;
  }

  /**
   * 全引き継ぎ一覧（フィルター付き）
   */
  static async getAll({ status, salesId, tutorId, limit = 50, offset = 0 } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      whereClause += ` AND h.status = $${params.length}`;
    }
    if (salesId) {
      params.push(salesId);
      whereClause += ` AND h.sales_user_id = $${params.length}`;
    }
    if (tutorId) {
      params.push(tutorId);
      whereClause += ` AND h.tutor_user_id = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await db.query(`
      SELECT
        h.*,
        s.name AS student_name,
        s.username AS student_username,
        sl.name AS sales_name,
        t.name AS tutor_name,
        t.username AS tutor_username,
        COUNT(*) OVER() AS total_count
      FROM handover_info h
      JOIN users s ON h.student_user_id = s.id
      LEFT JOIN users sl ON h.sales_user_id = sl.id
      LEFT JOIN users t ON h.tutor_user_id = t.id
      ${whereClause}
      ORDER BY h.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return result.rows;
  }

  /**
   * 未確認（submitted）の引き継ぎ一覧（Tutor向け）
   */
  static async getPendingForTutor(tutorId) {
    const result = await db.query(`
      SELECT
        h.*,
        s.name AS student_name,
        s.username AS student_username,
        sl.name AS sales_name
      FROM handover_info h
      JOIN users s ON h.student_user_id = s.id
      LEFT JOIN users sl ON h.sales_user_id = sl.id
      WHERE h.tutor_user_id = $1
        AND h.status = 'submitted'
      ORDER BY h.submitted_at ASC
    `, [tutorId]);
    return result.rows;
  }
}

module.exports = HandoverInfo;
