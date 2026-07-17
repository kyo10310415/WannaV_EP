const db = require('../config/database');

class SatisfactionSurvey {
  /**
   * 満足度アンケートを登録
   */
  static async create(data) {
    const {
      studentUserId, overallScore, lessonScore, supportScore,
      goodPoints, improvementPoints, freeComment,
      surveyDate, registeredBy, wantsExtension
    } = data;

    const result = await db.query(`
      INSERT INTO satisfaction_surveys
        (student_user_id, overall_score, lesson_score, support_score,
         good_points, improvement_points, free_comment,
         survey_date, registered_by, wants_extension)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      studentUserId,
      overallScore || null,
      lessonScore || null,
      supportScore || null,
      goodPoints || null,
      improvementPoints || null,
      freeComment || null,
      surveyDate || new Date().toISOString().split('T')[0],
      registeredBy || null,
      wantsExtension !== undefined ? wantsExtension : null
    ]);
    return result.rows[0];
  }

  /**
   * 特定生徒のアンケート履歴
   */
  static async getByStudentId(studentUserId) {
    const result = await db.query(`
      SELECT
        ss.*,
        u.name AS student_name,
        rb.name AS registered_by_name
      FROM satisfaction_surveys ss
      JOIN users u ON ss.student_user_id = u.id
      LEFT JOIN users rb ON ss.registered_by = rb.id
      WHERE ss.student_user_id = $1
      ORDER BY ss.survey_date DESC, ss.created_at DESC
    `, [studentUserId]);
    return result.rows;
  }

  /**
   * 全アンケート一覧（フィルター付き）
   */
  static async getAll({ tutorId, minScore, maxScore, limit = 50, offset = 0 } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (tutorId) {
      params.push(tutorId);
      whereClause += ` AND sp.assigned_tutor_id = $${params.length}`;
    }
    if (minScore !== undefined) {
      params.push(minScore);
      whereClause += ` AND ss.overall_score >= $${params.length}`;
    }
    if (maxScore !== undefined) {
      params.push(maxScore);
      whereClause += ` AND ss.overall_score <= $${params.length}`;
    }

    params.push(limit, offset);

    const result = await db.query(`
      SELECT
        ss.*,
        u.name AS student_name,
        u.username AS student_username,
        rb.name AS registered_by_name,
        sp.contract_plan,
        sp.assigned_tutor_id,
        t.name AS tutor_name,
        COUNT(*) OVER() AS total_count
      FROM satisfaction_surveys ss
      JOIN users u ON ss.student_user_id = u.id
      LEFT JOIN users rb ON ss.registered_by = rb.id
      LEFT JOIN student_profiles sp ON ss.student_user_id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      ${whereClause}
      ORDER BY ss.survey_date DESC, ss.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return result.rows;
  }

  /**
   * 満足度の統計（平均・分布）
   */
  static async getStats({ tutorId } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (tutorId) {
      params.push(tutorId);
      whereClause += ` AND sp.assigned_tutor_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT
        COUNT(*) AS total,
        ROUND(AVG(ss.overall_score), 2) AS avg_overall,
        ROUND(AVG(ss.lesson_score), 2) AS avg_lesson,
        ROUND(AVG(ss.support_score), 2) AS avg_support,
        COUNT(*) FILTER (WHERE ss.overall_score = 5) AS score_5,
        COUNT(*) FILTER (WHERE ss.overall_score = 4) AS score_4,
        COUNT(*) FILTER (WHERE ss.overall_score = 3) AS score_3,
        COUNT(*) FILTER (WHERE ss.overall_score = 2) AS score_2,
        COUNT(*) FILTER (WHERE ss.overall_score = 1) AS score_1
      FROM satisfaction_surveys ss
      LEFT JOIN student_profiles sp ON ss.student_user_id = sp.user_id
      ${whereClause}
    `, params);
    return result.rows[0];
  }

  /**
   * IDで取得
   */
  static async findById(id) {
    const result = await db.query(`
      SELECT ss.*, u.name AS student_name, rb.name AS registered_by_name
      FROM satisfaction_surveys ss
      JOIN users u ON ss.student_user_id = u.id
      LEFT JOIN users rb ON ss.registered_by = rb.id
      WHERE ss.id = $1
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * 更新
   */
  static async update(id, data) {
    const {
      overallScore, lessonScore, supportScore,
      goodPoints, improvementPoints, freeComment,
      surveyDate, wantsExtension
    } = data;

    const result = await db.query(`
      UPDATE satisfaction_surveys
      SET overall_score = COALESCE($1, overall_score),
          lesson_score = COALESCE($2, lesson_score),
          support_score = COALESCE($3, support_score),
          good_points = COALESCE($4, good_points),
          improvement_points = COALESCE($5, improvement_points),
          free_comment = COALESCE($6, free_comment),
          survey_date = COALESCE($7, survey_date),
          wants_extension = COALESCE($8, wants_extension)
      WHERE id = $9
      RETURNING *
    `, [
      overallScore || null,
      lessonScore || null,
      supportScore || null,
      goodPoints || null,
      improvementPoints || null,
      freeComment || null,
      surveyDate || null,
      wantsExtension !== undefined ? wantsExtension : null,
      id
    ]);
    return result.rows[0];
  }

  /**
   * 削除
   */
  static async delete(id) {
    await db.query('DELETE FROM satisfaction_surveys WHERE id = $1', [id]);
  }
}

module.exports = SatisfactionSurvey;
