const db = require('../config/database');

class ImportantMessage {
  static async getCurrent() {
    const result = await db.query('SELECT * FROM important_messages WHERE id = 1');
    return result.rows[0] || null;
  }

  static async save({ body, url, startsAt, endsAt }) {
    const result = await db.query(`
      INSERT INTO important_messages (id, body, url, starts_at, ends_at)
      VALUES (1, $1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        body = EXCLUDED.body,
        url = EXCLUDED.url,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        revision = important_messages.revision + 1,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [body, url, startsAt, endsAt]);
    return result.rows[0];
  }

  static async remove() {
    await db.query('DELETE FROM important_messages WHERE id = 1');
  }

  static async getVisibleFor(userId) {
    const result = await db.query(`
      SELECT m.* FROM important_messages m
      WHERE m.id = 1
        AND CURRENT_TIMESTAMP >= m.starts_at AND CURRENT_TIMESTAMP < m.ends_at
        AND NOT EXISTS (
          SELECT 1 FROM important_message_dismissals d
          WHERE d.user_id = $1 AND d.message_id = m.id AND d.revision = m.revision
            AND d.dismissed_on = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date
        )
    `, [userId]);
    return result.rows[0] || null;
  }

  static async dismissToday(userId, revision) {
    const result = await db.query(`
      INSERT INTO important_message_dismissals (user_id, message_id, revision, dismissed_on)
      SELECT $1, m.id, m.revision, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date
      FROM important_messages m
      WHERE m.id = 1 AND m.revision = $2
        AND CURRENT_TIMESTAMP >= m.starts_at AND CURRENT_TIMESTAMP < m.ends_at
      ON CONFLICT (user_id, message_id, revision, dismissed_on) DO NOTHING
      RETURNING user_id
    `, [userId, revision]);
    if (result.rows.length) return true;
    // Repeated dismissals for the same version and Japan date are harmless.
    const existing = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM important_message_dismissals d
        JOIN important_messages m ON m.id = d.message_id AND m.revision = d.revision
        WHERE d.user_id = $1 AND d.revision = $2
          AND d.dismissed_on = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date
          AND CURRENT_TIMESTAMP >= m.starts_at AND CURRENT_TIMESTAMP < m.ends_at
      ) AS dismissed
    `, [userId, revision]);
    return existing.rows[0]?.dismissed === true;
  }
}

module.exports = ImportantMessage;
