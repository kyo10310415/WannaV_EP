const db = require('../config/database');

class StudentGoal {
  // =====================================================
  // 目的（大目標）管理
  // =====================================================

  /**
   * 生徒の目的（purpose）を取得
   */
  static async getPurpose(userId) {
    const result = await db.query(`
      SELECT sg.*, u.name AS set_by_name
      FROM student_goals sg
      LEFT JOIN users u ON sg.set_by = u.id
      WHERE sg.user_id = $1 AND sg.goal_type = 'long' AND sg.status = 'active'
      ORDER BY sg.created_at DESC
      LIMIT 1
    `, [userId]);
    return result.rows[0] || null;
  }

  /**
   * 目的を設定/更新
   */
  static async setPurpose(userId, { purpose, setBy }) {
    // 既存アクティブな長期目標を一旦キャンセル
    await db.query(`
      UPDATE student_goals SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND goal_type = 'long' AND status = 'active'
    `, [userId]);

    const result = await db.query(`
      INSERT INTO student_goals
        (user_id, purpose, purpose_set_at, goal_type, set_by, status)
      VALUES ($1, $2, CURRENT_TIMESTAMP, 'long', $3, 'active')
      RETURNING *
    `, [userId, purpose, setBy || null]);
    return result.rows[0];
  }

  // =====================================================
  // 目標（短中期）管理
  // =====================================================

  /**
   * 生徒の目標一覧
   */
  static async getGoals(userId, { status } = {}) {
    let where = 'WHERE sg.user_id = $1 AND sg.goal_type != \'long\'';
    const params = [userId];
    if (status) {
      params.push(status);
      where += ` AND sg.status = $${params.length}`;
    }
    const result = await db.query(`
      SELECT sg.*,
        ub.name AS set_by_name,
        up.name AS progress_updated_by_name
      FROM student_goals sg
      LEFT JOIN users ub ON sg.set_by = ub.id
      LEFT JOIN users up ON sg.progress_updated_by = up.id
      ${where}
      ORDER BY sg.status ASC, sg.target_date ASC NULLS LAST, sg.created_at ASC
    `, params);
    return result.rows;
  }

  /**
   * 目標を作成
   */
  static async createGoal(userId, data) {
    const {
      goalTitle, goalDetail, goalType, targetDate,
      progressRate, setBy
    } = data;

    const result = await db.query(`
      INSERT INTO student_goals
        (user_id, goal_title, goal_detail, goal_type,
         target_date, progress_rate, set_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
      RETURNING *
    `, [
      userId,
      goalTitle,
      goalDetail || null,
      goalType || 'short',
      targetDate || null,
      progressRate || 0,
      setBy || null
    ]);
    return result.rows[0];
  }

  /**
   * 目標を更新
   */
  static async updateGoal(goalId, data) {
    const {
      goalTitle, goalDetail, goalType,
      targetDate, status
    } = data;
    const result = await db.query(`
      UPDATE student_goals SET
        goal_title = COALESCE($1, goal_title),
        goal_detail = COALESCE($2, goal_detail),
        goal_type = COALESCE($3, goal_type),
        target_date = COALESCE($4, target_date),
        status = COALESCE($5, status),
        achieved_at = CASE WHEN $5 = 'achieved' THEN CURRENT_TIMESTAMP ELSE achieved_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [goalTitle||null, goalDetail||null, goalType||null, targetDate||null, status||null, goalId]);
    return result.rows[0];
  }

  /**
   * 進捗度を更新
   */
  static async updateProgress(goalId, { progressRate, progressNote, updatedBy }) {
    const clampedRate = Math.min(100, Math.max(0, Math.round(progressRate)));
    const result = await db.query(`
      UPDATE student_goals SET
        progress_rate = $1,
        progress_note = COALESCE($2, progress_note),
        progress_updated_at = CURRENT_TIMESTAMP,
        progress_updated_by = $3,
        -- 100%になったら達成済みに
        status = CASE WHEN $1 = 100 THEN 'achieved' ELSE status END,
        achieved_at = CASE WHEN $1 = 100 THEN CURRENT_TIMESTAMP ELSE achieved_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [clampedRate, progressNote || null, updatedBy || null, goalId]);
    return result.rows[0];
  }

  /**
   * 目標を削除
   */
  static async deleteGoal(goalId) {
    await db.query('DELETE FROM student_goals WHERE id = $1', [goalId]);
  }

  /**
   * 目標IDで取得（権限確認用）
   */
  static async findById(goalId) {
    const result = await db.query(
      'SELECT * FROM student_goals WHERE id = $1',
      [goalId]
    );
    return result.rows[0] || null;
  }

  // =====================================================
  // 集計・ダッシュボード用
  // =====================================================

  /**
   * 生徒の目標進捗サマリー
   */
  static async getProgressSummary(userId) {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active_goals,
        COUNT(*) FILTER (WHERE status = 'achieved') AS achieved_goals,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_goals,
        ROUND(AVG(progress_rate) FILTER (WHERE status = 'active'), 1) AS avg_progress,
        COUNT(*) FILTER (WHERE status = 'active' AND target_date < CURRENT_DATE) AS overdue_goals
      FROM student_goals
      WHERE user_id = $1 AND goal_type != 'long'
    `, [userId]);
    return result.rows[0];
  }

  /**
   * 担当Tutorが持つ全生徒の目標状況
   */
  static async getAllForTutor(tutorId) {
    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username AS student_username,
        COUNT(sg.id) FILTER (WHERE sg.status = 'active') AS active_goals,
        COUNT(sg.id) FILTER (WHERE sg.status = 'achieved') AS achieved_goals,
        ROUND(AVG(sg.progress_rate) FILTER (WHERE sg.status = 'active'), 1) AS avg_progress,
        MAX(sg.progress_updated_at) AS last_progress_update,
        COUNT(sg.id) FILTER (WHERE sg.status = 'active' AND sg.target_date < CURRENT_DATE) AS overdue_goals
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN student_goals sg ON u.id = sg.user_id AND sg.goal_type != 'long'
      WHERE sp.assigned_tutor_id = $1 AND u.role = '生徒'
      GROUP BY u.id, u.name, u.username
      ORDER BY avg_progress ASC NULLS FIRST
    `, [tutorId]);
    return result.rows;
  }

  /**
   * 全生徒の目標進捗（管理者用）
   */
  static async getAllSummary() {
    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username,
        sp.status AS student_status,
        t.name AS tutor_name,
        COUNT(sg.id) FILTER (WHERE sg.status = 'active') AS active_goals,
        COUNT(sg.id) FILTER (WHERE sg.status = 'achieved') AS achieved_goals,
        ROUND(AVG(sg.progress_rate) FILTER (WHERE sg.status = 'active'), 1) AS avg_progress,
        COUNT(sg.id) FILTER (WHERE sg.status = 'active' AND sg.target_date < CURRENT_DATE) AS overdue_goals
      FROM users u
      LEFT JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN users t ON sp.assigned_tutor_id = t.id
      LEFT JOIN student_goals sg ON u.id = sg.user_id AND sg.goal_type != 'long'
      WHERE u.role = '生徒'
      GROUP BY u.id, u.name, u.username, sp.status, t.name
      ORDER BY avg_progress ASC NULLS FIRST
    `);
    return result.rows;
  }
}

module.exports = StudentGoal;
