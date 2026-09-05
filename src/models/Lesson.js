const db = require('../config/database');

class Lesson {
  static async create(data) {
    const {
      courseId, title, description, contentType, videoFilename, videoUrl,
      imageFilename, imageUrl, externalLinkUrl, duration, orderIndex, thumbnailUrl,
    } = data;
    const result = await db.query(
      `INSERT INTO lessons (
         course_id, title, description, content_type,
         video_filename, video_url, image_filename, image_url, external_link_url,
         thumbnail_url, duration, order_index
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        courseId, title, description, contentType, videoFilename, videoUrl,
        imageFilename, imageUrl, externalLinkUrl, thumbnailUrl, duration, orderIndex,
      ]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await db.query(`
      SELECT l.*, c.title AS course_title, c.sequential_unlock, c.is_special_content
      FROM lessons l
      LEFT JOIN courses c ON c.id = l.course_id
      WHERE l.id = $1
    `, [id]);
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
      SELECT l.*, c.title as course_title, c.sequential_unlock, c.is_special_content
      FROM lessons l
      LEFT JOIN courses c ON l.course_id = c.id
      ORDER BY c.order_index, c.id, l.order_index, l.id
    `);
    return result.rows;
  }

  static async update(id, data) {
    const {
      title, description, contentType, videoFilename, videoUrl,
      imageFilename, imageUrl, externalLinkUrl, thumbnailUrl,
      duration, orderIndex, courseId,
    } = data;
    const result = await db.query(
      `UPDATE lessons
       SET title = $1, description = $2, content_type = $3,
           video_filename = $4, video_url = $5,
           image_filename = $6, image_url = $7, external_link_url = $8,
           thumbnail_url = $9, duration = $10, order_index = $11,
           course_id = COALESCE($12, course_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $13 RETURNING *`,
      [
        title, description, contentType, videoFilename, videoUrl,
        imageFilename, imageUrl, externalLinkUrl, thumbnailUrl,
        duration, orderIndex, courseId || null, id,
      ]
    );
    return result.rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM lessons WHERE id = $1', [id]);
  }

  static async getWithProgress(userId, specialOnly = false) {
    const result = await db.query(`
      SELECT 
        l.*,
        c.title as course_title,
        c.sequential_unlock,
        c.is_special_content,
        COALESCE(up.completed, false) as completed,
        COALESCE(up.quiz_passed, false) as quiz_passed,
        COALESCE(up.watch_percent, 0) as watch_percent,
        up.last_watched_at
      FROM lessons l
      LEFT JOIN courses c ON l.course_id = c.id
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = $1
      WHERE COALESCE(c.is_special_content, false) = $2
      ORDER BY c.order_index, c.id, l.order_index, l.id
    `, [userId, specialOnly]);
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
