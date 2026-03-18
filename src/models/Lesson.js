const db = require('../config/database');

class Lesson {
  static async create(courseId, title, description, videoFilename, videoUrl, duration, orderIndex) {
    const result = await db.query(
      `INSERT INTO lessons (course_id, title, description, video_filename, video_url, duration, order_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [courseId, title, description, videoFilename, videoUrl, duration, orderIndex]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await db.query('SELECT * FROM lessons WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getByCourse(courseId) {
    const result = await db.query(
      'SELECT * FROM lessons WHERE course_id = $1 ORDER BY order_index ASC',
      [courseId]
    );
    return result.rows;
  }

  static async getAll() {
    const result = await db.query(`
      SELECT l.*, c.title as course_title 
      FROM lessons l
      LEFT JOIN courses c ON l.course_id = c.id
      ORDER BY c.order_index, l.order_index
    `);
    return result.rows;
  }

  static async update(id, data) {
    const { title, description, videoFilename, videoUrl, duration, orderIndex } = data;
    const result = await db.query(
      `UPDATE lessons 
       SET title = $1, description = $2, video_filename = $3, video_url = $4, 
           duration = $5, order_index = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [title, description, videoFilename, videoUrl, duration, orderIndex, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM lessons WHERE id = $1', [id]);
  }

  static async getWithProgress(userId) {
    const result = await db.query(`
      SELECT 
        l.*,
        c.title as course_title,
        COALESCE(up.completed, false) as completed,
        COALESCE(up.quiz_passed, false) as quiz_passed,
        up.last_watched_at
      FROM lessons l
      LEFT JOIN courses c ON l.course_id = c.id
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = $1
      ORDER BY c.order_index, l.order_index
    `, [userId]);
    return result.rows;
  }

  static async getNextLesson(userId, currentLessonId) {
    const result = await db.query(`
      SELECT l.* FROM lessons l
      WHERE l.order_index > (SELECT order_index FROM lessons WHERE id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM user_progress up 
        WHERE up.lesson_id = l.id AND up.user_id = $2 AND up.completed = true
      )
      ORDER BY l.order_index ASC
      LIMIT 1
    `, [currentLessonId, userId]);
    return result.rows[0];
  }
}

module.exports = Lesson;
