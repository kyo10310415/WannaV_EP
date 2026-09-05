const db = require('../config/database');

const LINK_KEYS = {
  bucchakeVtuberUrl: 'bucchake_vtuber_url',
  classLessonUrl: 'class_lesson_url',
};

class PortalSetting {
  static async getLinks() {
    const result = await db.query(`
      SELECT setting_key, setting_value
      FROM portal_settings
      WHERE setting_key = ANY($1::text[])
    `, [Object.values(LINK_KEYS)]);
    const values = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value || '']));
    return {
      bucchakeVtuberUrl: values[LINK_KEYS.bucchakeVtuberUrl] || '',
      classLessonUrl: values[LINK_KEYS.classLessonUrl] || '',
    };
  }

  static async updateLinks({ bucchakeVtuberUrl, classLessonUrl }) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [name, key] of Object.entries(LINK_KEYS)) {
        const value = name === 'bucchakeVtuberUrl' ? bucchakeVtuberUrl : classLessonUrl;
        await client.query(`
          INSERT INTO portal_settings (setting_key, setting_value, updated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          ON CONFLICT (setting_key) DO UPDATE
          SET setting_value = EXCLUDED.setting_value,
              updated_at = CURRENT_TIMESTAMP
        `, [key, value]);
      }
      await client.query('COMMIT');
      return this.getLinks();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PortalSetting;
module.exports.LINK_KEYS = LINK_KEYS;
