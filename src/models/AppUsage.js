const db = require('../config/database');

class AppUsage {
  static async recordOpen(userId) {
    const result = await db.query(`
      INSERT INTO app_usage_daily (user_id, usage_date, open_count, last_opened_at)
      SELECT
        id,
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date,
        1,
        CURRENT_TIMESTAMP
      FROM users
      WHERE id = $1 AND role = '生徒'
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET
        open_count = app_usage_daily.open_count + 1,
        last_opened_at = CURRENT_TIMESTAMP
      RETURNING usage_date, open_count, last_opened_at
    `, [userId]);
    return result.rows[0] || null;
  }
}

module.exports = AppUsage;
