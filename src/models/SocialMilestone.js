const db = require('../config/database');

function milestone(count) {
  if (!Number.isSafeInteger(count) || count < 100) return 0;
  const step = count < 1000 ? 100 : count < 10000 ? 1000 : 10000;
  return Math.floor(count / step) * step;
}

class SocialMilestone {
  static async cleanup(queryable = db) {
    await queryable.query(`DELETE FROM social_milestone_state WHERE platform = 'youtube'
      AND high_water_at < CURRENT_TIMESTAMP - INTERVAL '30 days'`);
    await queryable.query(`UPDATE social_milestone_state SET pending = NULL, pending_at = NULL
      WHERE platform = 'youtube' AND pending_at < CURRENT_TIMESTAMP - INTERVAL '30 days'`);
    await queryable.query(`DELETE FROM social_milestone_state s WHERE
      NOT EXISTS (SELECT 1 FROM notion_students ns WHERE ns.notion_page_id = s.source_id)
      AND NOT EXISTS (SELECT 1 FROM test_student_social_accounts a WHERE a.notion_page_id = s.source_id)`);
  }

  static async record(records, queryable = db) {
    await this.cleanup(queryable);
    const rows = records.filter(record => record.status === 'ok').map(record => ({
      source_id: record.notion_page_id, platform: record.platform,
      account_key: record.account_key, reached: milestone(Number(record.count))
    }));
    if (!rows.length) return;
    await queryable.query(`INSERT INTO social_milestone_state(source_id,platform,account_key,high_water,pending)
      SELECT source_id,platform,account_key,reached,NULL
      FROM jsonb_to_recordset($1::jsonb) AS r(source_id text,platform text,account_key text,reached bigint)
      ON CONFLICT (source_id,platform,account_key) DO UPDATE SET
        pending = CASE WHEN EXCLUDED.high_water > social_milestone_state.high_water
          THEN EXCLUDED.high_water ELSE social_milestone_state.pending END,
        pending_at = CASE WHEN EXCLUDED.high_water > social_milestone_state.high_water
          THEN CURRENT_TIMESTAMP ELSE social_milestone_state.pending_at END,
        high_water_at = CASE WHEN EXCLUDED.high_water >= social_milestone_state.high_water
          THEN CURRENT_TIMESTAMP ELSE social_milestone_state.high_water_at END,
        high_water = GREATEST(social_milestone_state.high_water, EXCLUDED.high_water),
        updated_at = CURRENT_TIMESTAMP`, [JSON.stringify(rows)]);
  }

  static async claim(userId, platform = null) {
    await this.cleanup();
    // Resolve identity on the server, never trust a student ID supplied by the browser.
    const result = await db.query(`WITH own AS (
        SELECT ns.notion_page_id AS source_id, 'x' AS platform, LOWER(LTRIM(TRIM(ns.x_username),'@')) AS account_key
          FROM student_profiles sp JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id WHERE sp.user_id = $1
        UNION ALL
        SELECT ns.notion_page_id, 'youtube', TRIM(ns.youtube_channel_id)
          FROM student_profiles sp JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id WHERE sp.user_id = $1
        UNION ALL
        SELECT a.notion_page_id, v.platform, v.account_key FROM test_student_social_accounts a
          JOIN users u ON u.id = a.user_id
          CROSS JOIN LATERAL (VALUES ('x',LOWER(LTRIM(TRIM(a.x_username),'@'))),('youtube',TRIM(a.youtube_channel_id))) v(platform,account_key)
          WHERE u.id = $1 AND u.username = 'test_seito' AND u.role = '生徒'
            AND NOT EXISTS (SELECT 1 FROM student_profiles sp WHERE sp.user_id = u.id AND sp.notion_page_id IS NOT NULL)
      ), candidates AS (
        SELECT s.source_id,s.platform,s.account_key,s.pending AS threshold
        FROM social_milestone_state s JOIN own ON
          s.source_id = own.source_id AND s.platform = own.platform AND s.account_key = own.account_key
        WHERE s.pending IS NOT NULL AND ($2::text IS NULL OR s.platform = $2) FOR UPDATE OF s
      ) UPDATE social_milestone_state s SET pending = NULL, pending_at = NULL FROM candidates c
      WHERE s.source_id = c.source_id AND s.platform = c.platform AND s.account_key = c.account_key
      RETURNING c.platform, c.threshold`, [userId, platform]);
    return result.rows.map(row => ({ platform: row.platform, threshold: Number(row.threshold) }))
      .sort((a, b) => a.platform.localeCompare(b.platform));
  }
}

module.exports = { SocialMilestone, milestone };
