const db = require('../config/database');

class ActivityLog {
  /**
   * ログを記録
   */
  static async log({ userId, action, targetType, targetId, detail, ipAddress } = {}) {
    try {
      await db.query(`
        INSERT INTO activity_logs (user_id, action, target_type, target_id, detail, ip_address)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId || null,
        action,
        targetType || null,
        targetId || null,
        detail ? JSON.stringify(detail) : null,
        ipAddress || null
      ]);
    } catch (err) {
      // ログ失敗はサイレントエラー（メイン処理をブロックしない）
      console.error('ActivityLog error:', err.message);
    }
  }

  /**
   * ログ一覧（フィルター付き）
   */
  static async getAll({ userId, action, targetType, limit = 100, offset = 0 } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (userId) {
      params.push(userId);
      whereClause += ` AND al.user_id = $${params.length}`;
    }
    if (action) {
      params.push(`%${action}%`);
      whereClause += ` AND al.action ILIKE $${params.length}`;
    }
    if (targetType) {
      params.push(targetType);
      whereClause += ` AND al.target_type = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await db.query(`
      SELECT
        al.*,
        u.name AS user_name,
        u.username,
        u.role AS user_role,
        COUNT(*) OVER() AS total_count
      FROM activity_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return result.rows;
  }

  /**
   * 古いログの削除（90日以上前）
   */
  static async deleteOldLogs(daysToKeep = 90) {
    const result = await db.query(`
      DELETE FROM activity_logs
      WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${daysToKeep} days'
      RETURNING id
    `);
    return result.rows.length;
  }
}

module.exports = ActivityLog;
