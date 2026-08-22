const db = require('../config/database');

class CharacterSelection {
  static async findById(selectionId) {
    const result = await db.query(`SELECT * FROM character_selections WHERE id = $1`, [selectionId]);
    return result.rows[0] || null;
  }

  static async findStoredById(selectionId) {
    const result = await db.query(`
      SELECT id, stored_image_filename, stored_image_mime_type
      FROM character_selections
      WHERE id = $1
        AND status = 'confirmed'
        AND stored_image_filename IS NOT NULL
    `, [selectionId]);
    return result.rows[0] || null;
  }

  static async findByStudent(studentUserId) {
    const result = await db.query(`
      SELECT
        cs.*,
        COALESCE(ns.student_number, u.username) AS student_number,
        COALESCE(ns.student_name, u.name) AS student_name
      FROM character_selections cs
      JOIN users u ON u.id = cs.student_user_id
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
      WHERE cs.student_user_id = $1
    `, [studentUserId]);
    return result.rows[0] || null;
  }

  static async getReservedFileIds() {
    const result = await db.query(`SELECT drive_file_id FROM character_selections`);
    return result.rows.map(row => row.drive_file_id);
  }

  static async createPending({ studentUserId, fileId, fileName, category }) {
    const result = await db.query(`
      INSERT INTO character_selections
        (student_user_id, drive_file_id, drive_file_name, category, status,
         selected_at, updated_at)
      VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `, [studentUserId, fileId, fileName, category]);
    return result.rows[0];
  }

  static async getAll(status) {
    const result = await db.query(`
      SELECT
        cs.*,
        COALESCE(ns.student_number, u.username) AS student_number,
        COALESCE(ns.student_name, u.name) AS student_name
      FROM character_selections cs
      JOIN users u ON u.id = cs.student_user_id
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
      WHERE cs.status = $1
      ORDER BY
        CASE WHEN cs.status = 'pending' THEN cs.selected_at ELSE cs.confirmed_at END DESC,
        cs.id DESC
    `, [status]);
    return result.rows;
  }

  static async confirm(selectionId, confirmedBy, storedImage) {
    const result = await db.query(`
      UPDATE character_selections
      SET status = 'confirmed',
          confirmed_by = $2,
          confirmed_at = CURRENT_TIMESTAMP,
          stored_image_filename = $3,
          stored_image_mime_type = $4,
          stored_image_size = $5,
          stored_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `, [selectionId, confirmedBy, storedImage.fileName, storedImage.mimeType, storedImage.size]);
    return result.rows[0] || null;
  }

  static async attachStoredImage(selectionId, storedImage) {
    const result = await db.query(`
      UPDATE character_selections
      SET stored_image_filename = $2,
          stored_image_mime_type = $3,
          stored_image_size = $4,
          stored_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND status = 'confirmed'
        AND stored_image_filename IS NULL
      RETURNING *
    `, [selectionId, storedImage.fileName, storedImage.mimeType, storedImage.size]);
    return result.rows[0] || null;
  }

  static async cancel(selectionId) {
    const result = await db.query(`
      DELETE FROM character_selections
      WHERE id = $1
      RETURNING *
    `, [selectionId]);
    return result.rows[0] || null;
  }
}

module.exports = CharacterSelection;
