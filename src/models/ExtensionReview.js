const db = require('../config/database');

class ExtensionReview {
  /**
   * 延長審査を作成
   */
  static async create(data) {
    const {
      studentUserId, triggerType, currentContractEndDate,
      reviewerId, notes
    } = data;

    const result = await db.query(`
      INSERT INTO extension_reviews
        (student_user_id, trigger_type, review_status,
         current_contract_end_date, reviewer_id, notes, review_start_date)
      VALUES ($1, $2, '審査中', $3, $4, $5, CURRENT_DATE)
      RETURNING *
    `, [
      studentUserId,
      triggerType || 'manual',
      currentContractEndDate || null,
      reviewerId || null,
      notes || null
    ]);
    return result.rows[0];
  }

  /**
   * 審査結果を更新
   */
  static async updateResult(id, data) {
    const { reviewStatus, result, resultReason, newContractEndDate, reviewerId } = data;

    const res = await db.query(`
      UPDATE extension_reviews
      SET review_status = $1,
          result = $2,
          result_reason = $3,
          new_contract_end_date = $4,
          reviewer_id = $5,
          review_end_date = CURRENT_DATE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [
      reviewStatus,
      result || null,
      resultReason || null,
      newContractEndDate || null,
      reviewerId || null,
      id
    ]);

    // 延長決定の場合、student_profiles の contract_end_date を更新
    if (result === '承認' && newContractEndDate) {
      const review = res.rows[0];
      if (review) {
        await db.query(`
          UPDATE student_profiles
          SET contract_end_date = $1, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $2
        `, [newContractEndDate, review.student_user_id]);
      }
    }

    return res.rows[0];
  }

  /**
   * 特定生徒の延長審査履歴
   */
  static async getByStudentId(studentUserId) {
    const result = await db.query(`
      SELECT
        er.*,
        u.name AS student_name,
        r.name AS reviewer_name
      FROM extension_reviews er
      JOIN users u ON er.student_user_id = u.id
      LEFT JOIN users r ON er.reviewer_id = r.id
      WHERE er.student_user_id = $1
      ORDER BY er.created_at DESC
    `, [studentUserId]);
    return result.rows;
  }

  /**
   * 全審査中リスト
   */
  static async getActiveReviews() {
    const result = await db.query(`
      SELECT
        er.*,
        u.name AS student_name,
        u.username AS student_username,
        r.name AS reviewer_name,
        sp.contract_plan,
        sp.assigned_tutor_id,
        t.name AS tutor_name
      FROM extension_reviews er
      JOIN users u ON er.student_user_id = u.id
      LEFT JOIN users r ON er.reviewer_id = r.id
      LEFT JOIN student_profiles sp ON er.student_user_id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      WHERE er.review_status IN ('審査中', '保留')
      ORDER BY er.created_at ASC
    `);
    return result.rows;
  }

  /**
   * 全審査リスト（フィルター付き）
   */
  static async getAll({ status, tutorId, limit = 50, offset = 0 } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      whereClause += ` AND er.review_status = $${params.length}`;
    }
    if (tutorId) {
      params.push(tutorId);
      whereClause += ` AND sp.assigned_tutor_id = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await db.query(`
      SELECT
        er.*,
        u.name AS student_name,
        u.username AS student_username,
        r.name AS reviewer_name,
        sp.contract_plan,
        sp.contract_end_date AS current_contract_end,
        sp.assigned_tutor_id,
        t.name AS tutor_name,
        COUNT(*) OVER() AS total_count
      FROM extension_reviews er
      JOIN users u ON er.student_user_id = u.id
      LEFT JOIN users r ON er.reviewer_id = r.id
      LEFT JOIN student_profiles sp ON er.student_user_id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      ${whereClause}
      ORDER BY er.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return result.rows;
  }

  /**
   * IDで取得
   */
  static async findById(id) {
    const result = await db.query(`
      SELECT
        er.*,
        u.name AS student_name,
        u.username AS student_username,
        r.name AS reviewer_name,
        sp.contract_plan,
        sp.assigned_tutor_id,
        t.name AS tutor_name
      FROM extension_reviews er
      JOIN users u ON er.student_user_id = u.id
      LEFT JOIN users r ON er.reviewer_id = r.id
      LEFT JOIN student_profiles sp ON er.student_user_id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      WHERE er.id = $1
    `, [id]);
    return result.rows[0] || null;
  }
}

module.exports = ExtensionReview;
