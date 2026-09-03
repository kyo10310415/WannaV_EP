const db = require('../config/database');

class Progress {
  static async recordView(userId, lessonId) {
    const result = await db.query(`
      INSERT INTO user_progress (user_id, lesson_id, view_count, last_watched_at)
      VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, lesson_id) 
      DO UPDATE SET
        view_count = user_progress.view_count + 1,
        last_watched_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId, lessonId]);
    return result.rows[0];
  }

  // 視聴率を更新（最大値のみ保存・下がらない）
  static async updateWatchPercent(userId, lessonId, percent) {
    const result = await db.query(`
      INSERT INTO user_progress (user_id, lesson_id, watch_percent, last_watched_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, lesson_id)
      DO UPDATE SET
        watch_percent = GREATEST(user_progress.watch_percent, $3),
        last_watched_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId, lessonId, Math.min(100, Math.max(0, Math.round(percent)))]);
    return result.rows[0];
  }

  // 動画視聴完了（クイズなしのレッスン用）
  static async completeByWatching(userId, lessonId) {
    const result = await db.query(`
      INSERT INTO user_progress (user_id, lesson_id, completed, watch_percent, last_watched_at, completed_at)
      VALUES ($1, $2, true, 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, lesson_id)
      DO UPDATE SET
        completed = true,
        watch_percent = 100,
        last_watched_at = CURRENT_TIMESTAMP,
        completed_at = COALESCE(user_progress.completed_at, CURRENT_TIMESTAMP)
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
        up.quiz_attempts,
        COALESCE(up.watch_percent, 0) as watch_percent
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

  static async getCourseProgressStats(userId) {
    const result = await db.query(`
      SELECT
        c.id AS course_id,
        c.title AS course_title,
        COUNT(l.id)::integer AS total_lessons,
        COUNT(l.id) FILTER (WHERE COALESCE(up.completed, false))::integer AS completed_lessons,
        ROUND(
          COUNT(l.id) FILTER (WHERE COALESCE(up.completed, false))::numeric /
          NULLIF(COUNT(l.id), 0) * 100,
          2
        ) AS completion_percentage
      FROM courses c
      JOIN lessons l ON l.course_id = c.id
      LEFT JOIN user_progress up ON up.lesson_id = l.id AND up.user_id = $1
      GROUP BY c.id, c.title, c.order_index
      ORDER BY c.order_index, c.id
    `, [userId]);
    return result.rows;
  }

  static async getFreeSubjectViewAnalytics() {
    const result = await db.query(`
      SELECT
        l.id AS lesson_id,
        l.title AS lesson_title,
        l.order_index,
        COALESCE(
          SUM(COALESCE(up.view_count, 0)) FILTER (WHERE u.role = '生徒'),
          0
        )::integer AS total_views,
        COALESCE(
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'userId', u.id,
              'studentNumber', u.username,
              'studentName', u.name,
              'viewCount', COALESCE(up.view_count, 0)
            )
            ORDER BY u.name, u.username
          ) FILTER (WHERE u.role = '生徒' AND COALESCE(up.view_count, 0) > 0),
          '[]'::jsonb
        ) AS student_views
      FROM lessons l
      JOIN courses c ON c.id = l.course_id
      LEFT JOIN user_progress up ON up.lesson_id = l.id
      LEFT JOIN users u ON u.id = up.user_id
      WHERE c.title = '自由科目'
      GROUP BY l.id, l.title, l.order_index
      ORDER BY l.order_index, l.id
    `);
    return result.rows;
  }

  static async getAllUsersProgress({ limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const result = await db.query(`
      WITH lesson_total AS (
        SELECT COUNT(*)::integer AS total_lessons FROM lessons
      ), progress_by_user AS (
        SELECT
          user_id,
          COUNT(*) FILTER (WHERE completed = true)::integer AS completed_lessons,
          MAX(last_watched_at) AS last_activity
        FROM user_progress
        GROUP BY user_id
      ), student_progress AS (
        SELECT
          u.id,
          COALESCE(ns.student_name, u.name) AS name,
          u.email,
          COALESCE(ns.status, sp.status, '未設定') AS contract_status,
          lt.total_lessons,
          COALESCE(p.completed_lessons, 0) AS completed_lessons,
          ROUND(
            COALESCE(p.completed_lessons, 0)::numeric /
            NULLIF(lt.total_lessons, 0) * 100,
            2
          ) AS completion_percentage,
          p.last_activity,
          CASE
            WHEN p.last_activity IS NULL THEN '未受講'
            WHEN p.last_activity < CURRENT_TIMESTAMP - INTERVAL '7 days' THEN '非アクティブ'
            WHEN p.last_activity < CURRENT_TIMESTAMP - INTERVAL '3 days' THEN '要注意'
            ELSE '活動中'
          END AS learning_status,
          CASE
            WHEN p.last_activity IS NULL THEN NULL
            ELSE GREATEST(0, CURRENT_DATE - p.last_activity::date)
          END AS days_since_activity
        FROM users u
        LEFT JOIN student_profiles sp ON sp.user_id = u.id
        LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
        LEFT JOIN progress_by_user p ON p.user_id = u.id
        CROSS JOIN lesson_total lt
        WHERE u.role = '生徒'
      )
      SELECT *, COUNT(*) OVER()::integer AS total_count
      FROM student_progress
      ORDER BY completion_percentage DESC NULLS LAST, name ASC
      LIMIT $1 OFFSET $2
    `, [safeLimit, safeOffset]);
    return result.rows;
  }

  static async getAllUsersProgressSummary() {
    const result = await db.query(`
      WITH progress_by_user AS (
        SELECT
          user_id,
          COUNT(*) FILTER (WHERE completed = true)::integer AS completed_lessons,
          MAX(last_watched_at) AS last_activity
        FROM user_progress
        GROUP BY user_id
      ), lesson_total AS (
        SELECT COUNT(*)::integer AS total_lessons FROM lessons
      )
      SELECT
        COUNT(*)::integer AS total_students,
        COUNT(*) FILTER (
          WHERE COALESCE(ns.status, sp.status) = 'アクティブ'
        )::integer AS contract_active_students,
        COUNT(*) FILTER (WHERE p.last_activity IS NULL)::integer AS not_started_students,
        COUNT(*) FILTER (
          WHERE p.last_activity >= CURRENT_TIMESTAMP - INTERVAL '3 days'
        )::integer AS learning_active_students,
        COUNT(*) FILTER (
          WHERE p.last_activity < CURRENT_TIMESTAMP - INTERVAL '3 days'
            AND p.last_activity >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        )::integer AS warning_students,
        COUNT(*) FILTER (
          WHERE p.last_activity < CURRENT_TIMESTAMP - INTERVAL '7 days'
        )::integer AS inactive_students,
        ROUND(
          AVG(
            COALESCE(p.completed_lessons, 0)::numeric /
            NULLIF(lt.total_lessons, 0) * 100
          ),
          2
        ) AS average_completion
      FROM users u
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
      LEFT JOIN progress_by_user p ON p.user_id = u.id
      CROSS JOIN lesson_total lt
      WHERE u.role = '生徒'
    `);
    return result.rows[0];
  }

  static async canAccessLesson(userId, lessonId) {
    const result = await db.query(`
      WITH current_lesson AS (
        SELECT l.id, l.course_id, l.order_index, c.sequential_unlock
        FROM lessons l
        JOIN courses c ON c.id = l.course_id
        WHERE l.id = $2
      ), previous_lesson AS (
        SELECT previous.id
        FROM lessons previous
        JOIN current_lesson current ON current.course_id = previous.course_id
        WHERE previous.order_index < current.order_index
           OR (previous.order_index = current.order_index AND previous.id < current.id)
        ORDER BY previous.order_index DESC, previous.id DESC
        LIMIT 1
      )
      SELECT CASE
        WHEN current.sequential_unlock = false THEN true
        WHEN previous.id IS NULL THEN true
        ELSE EXISTS (
          SELECT 1
          FROM user_progress up
          WHERE up.user_id = $1
            AND up.lesson_id = previous.id
            AND up.completed = true
        )
      END AS can_access
      FROM current_lesson current
      LEFT JOIN previous_lesson previous ON true
    `, [userId, lessonId]);

    return result.rows[0]?.can_access === true;
  }
}

module.exports = Progress;
