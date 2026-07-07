const db = require('../config/database');

class NotionStudent {
  /**
   * エントリープランの生徒を全件取得（synced_at 降順）
   */
  static async getAll() {
    const result = await db.query(`
      SELECT
        id, notion_page_id, student_name, name_furigana,
        student_number, notion_url, lesson_start_month,
        status, contract_plan, synced_at
      FROM notion_students
      WHERE contract_plan = 'エントリープラン'
      ORDER BY student_number ASC NULLS LAST, student_name ASC
    `);
    return result.rows;
  }

  /**
   * Notion から取得したデータを UPSERT（notion_page_id でユニーク）
   * entries = [{ notionPageId, studentName, nameFurigana, studentNumber,
   *              notionUrl, lessonStartMonth, status, contractPlan, rawData }]
   */
  static async upsertMany(entries) {
    if (!entries || entries.length === 0) return 0;

    let upserted = 0;
    for (const e of entries) {
      await db.query(`
        INSERT INTO notion_students
          (notion_page_id, student_name, name_furigana, student_number,
           notion_url, lesson_start_month, status, contract_plan, raw_data, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_TIMESTAMP)
        ON CONFLICT (notion_page_id) DO UPDATE SET
          student_name      = EXCLUDED.student_name,
          name_furigana     = EXCLUDED.name_furigana,
          student_number    = EXCLUDED.student_number,
          notion_url        = EXCLUDED.notion_url,
          lesson_start_month= EXCLUDED.lesson_start_month,
          status            = EXCLUDED.status,
          contract_plan     = EXCLUDED.contract_plan,
          raw_data          = EXCLUDED.raw_data,
          synced_at         = CURRENT_TIMESTAMP
      `, [
        e.notionPageId,
        e.studentName    || null,
        e.nameFurigana   || null,
        e.studentNumber  || null,
        e.notionUrl      || null,
        e.lessonStartMonth ? new Date(e.lessonStartMonth) : null,
        e.status         || null,
        e.contractPlan   || null,
        e.rawData ? JSON.stringify(e.rawData) : null
      ]);
      upserted++;
    }
    return upserted;
  }

  /**
   * エントリープラン以外を含め全件削除してから再挿入したい場合用
   * （今回は upsertMany を推奨のため補助メソッドのみ）
   */
  static async deleteNonEntryPlan() {
    await db.query(`DELETE FROM notion_students WHERE contract_plan != 'エントリープラン'`);
  }

  /**
   * 最後の同期日時を返す
   */
  static async getLastSyncedAt() {
    const result = await db.query(`SELECT MAX(synced_at) AS last_synced FROM notion_students`);
    return result.rows[0]?.last_synced || null;
  }
}

module.exports = NotionStudent;
