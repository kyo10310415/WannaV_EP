const db = require('../config/database');
const User = require('./User');
const { TARGET_CONTRACT_PLANS } = require('../config/contractPlans');

class NotionStudent {
  /**
   * 対象6プランの生徒を全件取得
   */
  static async getAll() {
    const result = await db.query(`
      SELECT
        id, notion_page_id, student_name, name_furigana,
        student_number, notion_url, lesson_start_month,
        status, contract_plan, login_id, login_id_overridden, synced_at
      FROM notion_students
      WHERE contract_plan = ANY($1::text[])
      ORDER BY student_number ASC NULLS LAST, student_name ASC
    `, [TARGET_CONTRACT_PLANS]);
    return result.rows;
  }

  /**
   * Notion から取得したデータを UPSERT（notion_page_id でユニーク）
   * entries = [{ notionPageId, studentName, nameFurigana, studentNumber,
   *              notionUrl, lessonStartMonth, status, contractPlan, loginId, rawData }]
   */
  static async upsertMany(entries) {
    const summary = { upserted: 0, accountsCreated: 0, accountsLinked: 0, accountsSkipped: 0 };
    if (!entries || entries.length === 0) return summary;

    // 同期前のログインID・アカウント紐づけ状態を一括取得し、
    // 変更のない既存アカウントでは重いアカウント確認処理を行わない。
    const pageIds = entries.map(entry => entry.notionPageId);
    const stateResult = await db.query(`
      SELECT
        ns.notion_page_id,
        ns.login_id,
        ns.login_id_overridden,
        EXISTS (
          SELECT 1
          FROM student_profiles sp
          JOIN users u ON u.id = sp.user_id AND u.role = '生徒'
          WHERE sp.notion_page_id = ns.notion_page_id
        ) AS has_account
      FROM notion_students ns
      WHERE ns.notion_page_id = ANY($1::text[])
    `, [pageIds]);
    const previousStates = new Map(
      stateResult.rows.map(row => [row.notion_page_id, row])
    );

    // raw_data を含むため1パラメータが過大にならないよう200件単位で一括UPSERTする。
    const chunkSize = 200;
    for (let start = 0; start < entries.length; start += chunkSize) {
      const chunk = entries.slice(start, start + chunkSize).map(e => ({
        notion_page_id: e.notionPageId,
        student_name: e.studentName || null,
        name_furigana: e.nameFurigana || null,
        student_number: e.studentNumber || null,
        notion_url: e.notionUrl || null,
        lesson_start_month: e.lessonStartMonth
          ? new Date(e.lessonStartMonth).toISOString().slice(0, 10)
          : null,
        status: e.status || null,
        contract_plan: e.contractPlan || null,
        login_id: e.loginId || null,
        raw_data: e.rawData || null,
      }));
      await db.query(`
        INSERT INTO notion_students
          (notion_page_id, student_name, name_furigana, student_number,
           notion_url, lesson_start_month, status, contract_plan, login_id,
           login_id_overridden, raw_data, synced_at)
        SELECT
          incoming.notion_page_id,
          incoming.student_name,
          incoming.name_furigana,
          incoming.student_number,
          incoming.notion_url,
          incoming.lesson_start_month,
          incoming.status,
          incoming.contract_plan,
          incoming.login_id,
          FALSE,
          incoming.raw_data,
          CURRENT_TIMESTAMP
        FROM jsonb_to_recordset($1::jsonb) AS incoming(
          notion_page_id varchar,
          student_name varchar,
          name_furigana varchar,
          student_number varchar,
          notion_url text,
          lesson_start_month date,
          status varchar,
          contract_plan varchar,
          login_id varchar,
          raw_data jsonb
        )
        ON CONFLICT (notion_page_id) DO UPDATE SET
          student_name       = EXCLUDED.student_name,
          name_furigana      = EXCLUDED.name_furigana,
          student_number     = EXCLUDED.student_number,
          notion_url         = EXCLUDED.notion_url,
          lesson_start_month = EXCLUDED.lesson_start_month,
          status             = EXCLUDED.status,
          contract_plan      = EXCLUDED.contract_plan,
          login_id           = CASE
            WHEN notion_students.login_id_overridden THEN notion_students.login_id
            ELSE EXCLUDED.login_id
          END,
          raw_data           = EXCLUDED.raw_data,
          synced_at          = CURRENT_TIMESTAMP
      `, [JSON.stringify(chunk)]);
      summary.upserted += chunk.length;
    }

    for (const e of entries) {
      const previous = previousStates.get(e.notionPageId);
      const effectiveLoginId = previous?.login_id_overridden
        ? previous.login_id
        : e.loginId;
      const loginChanged = !previous
        || String(previous.login_id || '').toLowerCase() !== String(effectiveLoginId || '').toLowerCase();
      if (previous?.has_account && !loginChanged) {
        summary.accountsSkipped++;
        continue;
      }

      const provisioned = await NotionStudent.provisionAccount({
        notionPageId: e.notionPageId,
        loginId: effectiveLoginId,
        studentName: e.studentName,
      });
      if (provisioned.status === 'created') summary.accountsCreated++;
      else if (provisioned.status === 'linked') summary.accountsLinked++;
      else summary.accountsSkipped++;
    }
    return summary;
  }

  /**
   * Notion生徒に対応するログインアカウントを用意する。
   * 新規アカウントは学籍番号をログインID、初期PW「1111」で作成する。
   * password_changed_at はNULLのままにするため、
   * 既存のログイン処理によって初回パスワード変更が必須になる。
   */
  static async provisionAccount({ notionPageId, loginId, studentName }) {
    if (!loginId) {
      console.warn(`⚠️ アカウント作成スキップ: 学籍番号なし (${notionPageId})`);
      return { status: 'skipped', reason: 'missing_student_number' };
    }

    let client;
    try {
      client = await db.pool.connect();
      await client.query('BEGIN');

      const duplicateNotion = await client.query(`
        SELECT COUNT(*)::integer AS count
        FROM notion_students
        WHERE LOWER(login_id) = LOWER($1)
      `, [loginId]);
      if (duplicateNotion.rows[0].count !== 1) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ アカウント作成スキップ: 学籍番号がNotion内で重複 (${loginId})`);
        return { status: 'skipped', reason: 'duplicate_student_number' };
      }

      const linkedUsers = await client.query(`
        SELECT u.id, u.role, u.username, u.email, u.name
        FROM users u
        JOIN student_profiles sp ON sp.user_id = u.id
        WHERE sp.notion_page_id = $1
      `, [notionPageId]);
      if (linkedUsers.rows.length > 1) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ アカウント作成スキップ: Notionページの紐づけが重複 (${notionPageId})`);
        return { status: 'skipped', reason: 'duplicate_notion_link' };
      }

      const loginMatches = await client.query(`
        SELECT id, role, username, email, name
        FROM users
        WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
      `, [loginId]);

      let user = linkedUsers.rows[0] || null;
      if (user) {
        const conflictingUser = loginMatches.rows.find(match => match.id !== user.id);
        if (user.role !== '生徒' || conflictingUser) {
          await client.query('ROLLBACK');
          console.warn(`⚠️ アカウント作成スキップ: 学籍番号が別アカウントで使用中 (${loginId})`);
          return { status: 'skipped', reason: 'login_id_conflict' };
        }
      } else if (loginMatches.rows.length === 1 && loginMatches.rows[0].role === '生徒') {
        user = loginMatches.rows[0];
      } else if (loginMatches.rows.length > 0) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ アカウント作成スキップ: 学籍番号が既に使用中 (${loginId})`);
        return { status: 'skipped', reason: 'login_id_conflict' };
      }

      // 旧画面で別のログインIDを付けて作成済みの場合は、氏名が双方で一意なときだけ再利用する。
      if (!user && studentName) {
        const nameMatches = await client.query(`
          SELECT id, role, username, email, name
          FROM users
          WHERE role = '生徒' AND name = $1
        `, [studentName]);
        const notionNameCount = await client.query(`
          SELECT COUNT(*)::integer AS count
          FROM notion_students
          WHERE student_name = $1
        `, [studentName]);
        if (nameMatches.rows.length === 1 && notionNameCount.rows[0].count === 1) {
          user = nameMatches.rows[0];
        }
      }

      let created = false;
      if (!user) {
        user = await User.create(loginId, '1111', studentName || loginId, '生徒', client);
        created = true;
      }

      const existingProfile = await client.query(`
        SELECT notion_page_id FROM student_profiles WHERE user_id = $1
      `, [user.id]);
      if (existingProfile.rows[0]?.notion_page_id
          && existingProfile.rows[0].notion_page_id !== notionPageId) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ アカウント作成スキップ: アカウントが別のNotion生徒に紐づいています (${loginId})`);
        return { status: 'skipped', reason: 'account_link_conflict' };
      }

      const otherProfile = await client.query(`
        SELECT user_id FROM student_profiles
        WHERE notion_page_id = $1 AND user_id <> $2
        LIMIT 1
      `, [notionPageId, user.id]);
      if (otherProfile.rows.length > 0) {
        await client.query('ROLLBACK');
        return { status: 'skipped', reason: 'notion_link_conflict' };
      }

      await client.query(`
        INSERT INTO student_profiles (user_id, notion_page_id, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET
          notion_page_id = EXCLUDED.notion_page_id,
          updated_at = CURRENT_TIMESTAMP
      `, [user.id, notionPageId]);
      await client.query(`
        UPDATE users
        SET username = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [loginId, user.id]);

      await client.query('COMMIT');
      return { status: created ? 'created' : 'linked', userId: user.id };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(`❌ Notion生徒アカウント作成エラー (${loginId}):`, error.message);
      return { status: 'skipped', reason: 'provision_error' };
    } finally {
      client?.release();
    }
  }

  /**
   * 対象外プランを削除する場合用
   * （今回は upsertMany を推奨のため補助メソッドのみ）
   */
  static async deleteNonTargetPlans() {
    await db.query(
      `DELETE FROM notion_students WHERE NOT (contract_plan = ANY($1::text[]))`,
      [TARGET_CONTRACT_PLANS]
    );
  }

  static async deleteNonEntryPlan() {
    return NotionStudent.deleteNonTargetPlans();
  }

  /**
   * 最後の同期日時を返す
   */
  static async getLastSyncedAt() {
    const result = await db.query(`SELECT MAX(synced_at) AS last_synced FROM notion_students`);
    return result.rows[0]?.last_synced || null;
  }

  /**
   * 生徒管理画面でログインIDを上書きする。
   * Notion再同期時にも手動設定値を維持するため、上書きフラグを立てる。
   */
  static async updateLoginId(notionPageId, loginId, queryable = db) {
    const result = await queryable.query(`
      UPDATE notion_students
      SET login_id = $1,
          login_id_overridden = TRUE,
          synced_at = CURRENT_TIMESTAMP
      WHERE notion_page_id = $2
      RETURNING notion_page_id, login_id, login_id_overridden
    `, [loginId, notionPageId]);
    return result.rows[0] || null;
  }
}

module.exports = NotionStudent;
