const db = require('../config/database');
const { sessionMinutes } = require('../config/portal');

class AppUsage {
  static async recordOpen(userId) {
    const result = await db.query(`
      WITH activity AS (
        INSERT INTO portal_visit_state
          (user_id, last_activity_at, visit_started_at, last_event_started_visit)
        SELECT id, statement_timestamp(), statement_timestamp(),
          NOT EXISTS (
            SELECT 1 FROM app_usage_daily old
            WHERE old.user_id = users.id
              AND old.last_opened_at > statement_timestamp() - $2 * INTERVAL '1 minute'
          )
        FROM users WHERE id = $1 AND role = '生徒'
        ON CONFLICT (user_id) DO UPDATE SET
          last_event_started_visit =
            portal_visit_state.last_activity_at <= statement_timestamp() - $2 * INTERVAL '1 minute',
          visit_started_at = CASE
            WHEN portal_visit_state.last_activity_at <= statement_timestamp() - $2 * INTERVAL '1 minute'
            THEN statement_timestamp() ELSE portal_visit_state.visit_started_at END,
          last_activity_at = GREATEST(portal_visit_state.last_activity_at, statement_timestamp())
        RETURNING user_id, last_activity_at, last_event_started_visit
      ), active_day AS (
        INSERT INTO portal_active_days (user_id, activity_date)
        SELECT user_id, (last_activity_at AT TIME ZONE 'Asia/Tokyo')::date FROM activity
        ON CONFLICT (user_id, activity_date) DO NOTHING
        RETURNING user_id
      ), counted AS (
      INSERT INTO app_usage_daily (user_id, usage_date, open_count, last_opened_at)
      SELECT
        user_id,
        (last_activity_at AT TIME ZONE 'Asia/Tokyo')::date,
        1,
        last_activity_at
      FROM activity WHERE last_event_started_visit
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET
        open_count = app_usage_daily.open_count + 1,
        last_opened_at = EXCLUDED.last_opened_at
      RETURNING usage_date, open_count, last_opened_at
      )
      SELECT activity.last_event_started_visit AS recorded, counted.*
      FROM activity LEFT JOIN counted ON true
    `, [userId, sessionMinutes()]);
    return result.rows[0] || null;
  }
}

module.exports = AppUsage;
