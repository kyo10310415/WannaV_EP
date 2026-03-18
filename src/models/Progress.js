const db = require('../config/database');

class Progress {
  static async recordView(userId, lessonId) {
    const result = await db.query(`
      INSERT INTO user_progress (user_id, lesson_id, last_watched_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, lesson_id) 
      DO UPDATE SET last_watched_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId, lessonId]);
    return result.rows[0];
  }

  static async completeQuiz(userId, lessonId, passed) {
    const result = await db.query(`
      INSERT INTO user_progress (user_id, lesson_id, quiz_passed, quiz_attempts, completed, completed_at)
      VALUES ($1, $2, $3, 1, $3, CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT (user_id, lesson_id) 
      DO UPDATE SET 
        quiz_passed = $3,
        quiz_attempts = user_progress.quiz_attempts + 1,
        completed = $3,
        completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE user_progress.completed_at END,
        last_watched_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId, lessonId, passed]);
    return result.rows[0];
  }

  static async getUserProgress(userId) {
    const result = await db.query(`
      SELECT 
        l.id as lesson_id,
        l.title as lesson_title,
        c.title as course_title,
        up.completed,
        up.quiz_passed,
        up.last_watched_at,
        up.completed_at,
        up.quiz_attempts
      FROM user_progress up
      JOIN lessons l ON up.lesson_id = l.id
      JOIN courses c ON l.course_id = c.id
      WHERE up.user_id = $1
      ORDER BY c.order_index, l.order_index
    `, [userId]);
    return result.rows;
  }

  static async getProgressStats(userId) {
    const result = await db.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_lessons,
        COUNT(DISTINCT CASE WHEN up.completed THEN l.id END) as completed_lessons,
        ROUND(
          COUNT(DISTINCT CASE WHEN up.completed THEN l.id END)::numeric / 
          NULLIF(COUNT(DISTINCT l.id), 0) * 100, 2
        ) as completion_percentage
      FROM lessons l
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = $1
    `, [userId]);
    return result.rows[0];
  }

  static async getAllUsersProgress() {
    const result = await db.query(`
      SELECT 
        u.id,
        u.name,
        u.email,
        COUNT(DISTINCT l.id) as total_lessons,
        COUNT(DISTINCT CASE WHEN up.completed THEN l.id END) as completed_lessons,
        ROUND(
          COUNT(DISTINCT CASE WHEN up.completed THEN l.id END)::numeric / 
          NULLIF(COUNT(DISTINCT l.id), 0) * 100, 2
        ) as completion_percentage,
        MAX(up.last_watched_at) as last_activity
      FROM users u
      CROSS JOIN lessons l
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = u.id
      WHERE u.role = '生徒'
      GROUP BY u.id, u.name, u.email
      ORDER BY completion_percentage DESC NULLS LAST
    `);
    return result.rows;
  }

  static async canAccessLesson(userId, lessonId) {
    // 最初のレッスンは常にアクセス可能
    const isFirstLesson = await db.query(`
      SELECT 1 FROM lessons 
      WHERE id = $1 
      AND order_index = (SELECT MIN(order_index) FROM lessons WHERE course_id = (SELECT course_id FROM lessons WHERE id = $1))
    `, [lessonId]);
    
    if (isFirstLesson.rows.length > 0) return true;

    // 前のレッスンが完了しているかチェック
    const result = await db.query(`
      SELECT 1 FROM user_progress up
      JOIN lessons l ON up.lesson_id = l.id
      WHERE up.user_id = $1
      AND l.order_index = (SELECT order_index - 1 FROM lessons WHERE id = $2)
      AND up.completed = true
    `, [userId, lessonId]);

    return result.rows.length > 0;
  }
}

module.exports = Progress;
