const db = require('../config/database');
const StudentProfile = require('./StudentProfile');

const ENTRY_PLAN = 'エントリープラン';

function invalidTemplate(message) {
  const error = new Error(message);
  error.code = 'INVALID_SCHEDULE_TEMPLATE';
  return error;
}

function normalizeTemplateData(data = {}) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) throw invalidTemplate('テンプレート名を入力してください');
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw invalidTemplate('テンプレートには1件以上のレッスンが必要です');
  }

  const items = data.items.map((rawItem, index) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const lessonId = Number(item.lessonId);
    const dayOffset = item.dayOffset === null || item.dayOffset === undefined || item.dayOffset === ''
      ? Number.NaN
      : Number(item.dayOffset);
    const dueOffset = item.dueOffset === null || item.dueOffset === undefined || item.dueOffset === ''
      ? null
      : Number(item.dueOffset);
    const priority = item.priority === null || item.priority === undefined || item.priority === ''
      ? 1
      : Number(item.priority);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
      throw invalidTemplate(`${index + 1}行目のレッスンを選択してください`);
    }
    if (!Number.isInteger(dayOffset) || dayOffset < 0) {
      throw invalidTemplate(`${index + 1}行目のdayOffsetは0以上の整数で入力してください`);
    }
    if (dueOffset !== null && (!Number.isInteger(dueOffset) || dueOffset < 0)) {
      throw invalidTemplate(`${index + 1}行目の期限Offsetは空欄または0以上の整数で入力してください`);
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
      throw invalidTemplate(`${index + 1}行目の優先度が不正です`);
    }

    return {
      lessonId,
      dayOffset,
      dueOffset,
      priority,
      note: typeof item.note === 'string' && item.note !== '' ? item.note : null
    };
  });

  return {
    name,
    description: typeof data.description === 'string' && data.description.trim()
      ? data.description.trim()
      : null,
    contractPlan: ENTRY_PLAN,
    items
  };
}

function parseIsoDate(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) throw invalidTemplate('開始日の形式が不正です');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw invalidTemplate('開始日が不正です');
  }
  return date;
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

class LessonSchedule {
  // =====================================================
  // スケジュール作成・更新
  // =====================================================

  /**
   * スケジュールを1件作成
   */
  static async create(data, queryable = db) {
    const {
      userId, lessonId, scheduledDate, dueDate,
      orderInSchedule, priority, tutorNote, createdBy
    } = data;

    const result = await queryable.query(`
      INSERT INTO lesson_schedules
        (user_id, lesson_id, scheduled_date, due_date,
         order_in_schedule, priority, tutor_note, created_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      ON CONFLICT (user_id, lesson_id, scheduled_date) DO UPDATE SET
        due_date = EXCLUDED.due_date,
        order_in_schedule = EXCLUDED.order_in_schedule,
        priority = EXCLUDED.priority,
        tutor_note = EXCLUDED.tutor_note,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      userId, lessonId, scheduledDate,
      dueDate || null,
      orderInSchedule || 0,
      priority || 0,
      tutorNote || null,
      createdBy || null
    ]);
    return result.rows[0];
  }

  /**
   * テンプレートから一括スケジュール生成
   * startDate を基準に dayOffset を加算してスケジュールを作成
   */
  static async bulkCreateFromTemplate(userId, templateId, startDate, createdBy) {
    let client;
    try {
      client = await db.pool.connect();
      await client.query('BEGIN');

      const isEntryPlanStudent = await StudentProfile.isEntryPlanStudent(userId, client);
      if (!isEntryPlanStudent) {
        const error = new Error('エントリープランの生徒のみスケジュールを生成できます');
        error.code = 'SCHEDULE_STUDENT_NOT_ALLOWED';
        throw error;
      }

      const tRes = await client.query(`
        SELECT * FROM schedule_templates
        WHERE id = $1 AND is_active = true
      `, [templateId]);
      const template = tRes.rows[0];
      if (!template) throw invalidTemplate('利用可能なテンプレートが見つかりません');

      const { items } = normalizeTemplateData(template);
      const base = parseIsoDate(startDate);
      const created = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const scheduledDate = addUtcDays(base, item.dayOffset);
        const dueDate = item.dueOffset === null
          ? null
          : addUtcDays(parseIsoDate(scheduledDate), item.dueOffset);

        const row = await LessonSchedule.create({
          userId,
          lessonId: item.lessonId,
          scheduledDate,
          dueDate,
          orderInSchedule: i,
          priority: item.priority,
          tutorNote: item.note || null,
          createdBy
        }, client);
        created.push(row);
      }

      await client.query('COMMIT');
      return created;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client?.release();
    }
  }

  /**
   * スケジュールを更新
   */
  static async update(scheduleId, data) {
    const { scheduledDate, dueDate, status, tutorNote, priority } = data;
    const result = await db.query(`
      UPDATE lesson_schedules SET
        scheduled_date = COALESCE($1, scheduled_date),
        due_date = COALESCE($2, due_date),
        status = COALESCE($3, status),
        tutor_note = COALESCE($4, tutor_note),
        priority = COALESCE($5, priority),
        completed_at = CASE WHEN $3 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [scheduledDate||null, dueDate||null, status||null, tutorNote||null, priority||null, scheduleId]);
    return result.rows[0];
  }

  /**
   * 削除
   */
  static async delete(scheduleId) {
    await db.query('DELETE FROM lesson_schedules WHERE id = $1', [scheduleId]);
  }

  // =====================================================
  // 取得
  // =====================================================

  /**
   * 特定生徒のスケジュール一覧（レッスン・進捗情報付き）
   */
  static async getByUser(userId, { from, to, status } = {}) {
    let where = 'WHERE ls.user_id = $1';
    const params = [userId];

    if (from) { params.push(from); where += ` AND ls.scheduled_date >= $${params.length}`; }
    if (to)   { params.push(to);   where += ` AND ls.scheduled_date <= $${params.length}`; }
    if (status) { params.push(status); where += ` AND ls.status = $${params.length}`; }

    const result = await db.query(`
      SELECT
        ls.*,
        l.title AS lesson_title,
        l.description AS lesson_description,
        l.video_url,
        l.duration,
        l.thumbnail_url,
        c.title AS course_title,
        c.id AS course_id,
        -- 実際の進捗
        COALESCE(up.completed, false) AS lesson_completed,
        COALESCE(up.watch_percent, 0) AS watch_percent,
        up.completed_at AS lesson_completed_at,
        -- 遅延フラグ
        CASE
          WHEN ls.due_date < CURRENT_DATE AND ls.status NOT IN ('completed','skipped') THEN true
          ELSE false
        END AS is_overdue
      FROM lesson_schedules ls
      JOIN lessons l ON ls.lesson_id = l.id
      JOIN courses c ON l.course_id = c.id
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = ls.user_id
      ${where}
      ORDER BY ls.scheduled_date ASC, ls.order_in_schedule ASC
    `, params);
    return result.rows;
  }

  /**
   * 今週のスケジュール
   */
  static async getThisWeek(userId) {
    const result = await db.query(`
      SELECT
        ls.*,
        l.title AS lesson_title,
        l.duration,
        l.thumbnail_url,
        c.title AS course_title,
        COALESCE(up.completed, false) AS lesson_completed,
        COALESCE(up.watch_percent, 0) AS watch_percent,
        CASE
          WHEN ls.due_date < CURRENT_DATE AND ls.status NOT IN ('completed','skipped') THEN true
          ELSE false
        END AS is_overdue
      FROM lesson_schedules ls
      JOIN lessons l ON ls.lesson_id = l.id
      JOIN courses c ON l.course_id = c.id
      LEFT JOIN user_progress up ON l.id = up.lesson_id AND up.user_id = ls.user_id
      WHERE ls.user_id = $1
        AND ls.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      ORDER BY ls.scheduled_date ASC, ls.order_in_schedule ASC
    `, [userId]);
    return result.rows;
  }

  /**
   * 生徒スケジュール概況
   * tutorId 指定時は担当生徒のみ、未指定時は全生徒を取得する。
   */
  static async getOverviewForTutor(tutorId = null) {
    const params = [];
    let tutorFilter = '';
    if (tutorId) {
      params.push(tutorId);
      tutorFilter = `AND sp.assigned_tutor_id = $${params.length}`;
    }

    const result = await db.query(`
      SELECT
        u.id AS user_id,
        u.name AS student_name,
        u.username AS student_username,
        COUNT(ls.id) AS total_schedules,
        COUNT(ls.id) FILTER (WHERE ls.status = 'completed') AS completed,
        COUNT(ls.id) FILTER (WHERE ls.status = 'pending') AS pending,
        COUNT(ls.id) FILTER (
          WHERE ls.due_date < CURRENT_DATE AND ls.status NOT IN ('completed','skipped')
        ) AS overdue,
        MIN(ls.scheduled_date) FILTER (WHERE ls.status = 'pending') AS next_lesson_date
      FROM users u
      JOIN student_profiles sp ON u.id = sp.user_id
      LEFT JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
      LEFT JOIN lesson_schedules ls ON u.id = ls.user_id
      WHERE u.role = '生徒'
        AND COALESCE(ns.contract_plan, sp.contract_plan) = '${ENTRY_PLAN}'
        ${tutorFilter}
      GROUP BY u.id, u.name, u.username
      ORDER BY overdue DESC, next_lesson_date ASC NULLS LAST
    `, params);
    return result.rows;
  }

  /**
   * 進捗とスケジュールを自動同期
   * （lesson_completed が true の場合 schedule を completed に更新）
   */
  static async syncWithProgress(userId) {
    await db.query(`
      UPDATE lesson_schedules ls
      SET status = 'completed',
          completed_at = up.completed_at,
          updated_at = CURRENT_TIMESTAMP
      FROM user_progress up
      WHERE ls.user_id = up.user_id
        AND ls.lesson_id = up.lesson_id
        AND up.completed = true
        AND ls.status NOT IN ('completed', 'skipped')
        AND ls.user_id = $1
    `, [userId]);
  }

  // =====================================================
  // テンプレート管理
  // =====================================================

  /**
   * テンプレート一覧
   */
  static async getTemplates() {
    const result = await db.query(`
      SELECT
        st.id,
        st.name,
        st.description,
        '${ENTRY_PLAN}' AS contract_plan,
        st.items,
        st.created_by,
        st.is_active,
        st.created_at,
        st.updated_at,
        u.name AS created_by_name,
        jsonb_array_length(st.items) AS item_count
      FROM schedule_templates st
      LEFT JOIN users u ON st.created_by = u.id
      WHERE st.is_active = true
      ORDER BY st.created_at DESC
    `);
    return result.rows;
  }

  /**
   * テンプレート作成
   */
  static async createTemplate(data) {
    const { name, description, contractPlan, items } = normalizeTemplateData(data);
    const { createdBy } = data;
    const result = await db.query(`
      INSERT INTO schedule_templates (name, description, contract_plan, items, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, description || null, contractPlan || null, JSON.stringify(items || []), createdBy || null]);
    return result.rows[0];
  }

  /**
   * テンプレート更新
   */
  static async updateTemplate(templateId, data) {
    const { name, description, contractPlan, items } = normalizeTemplateData(data);
    const result = await db.query(`
      UPDATE schedule_templates SET
        name = $1,
        description = $2,
        contract_plan = $3,
        items = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5 AND is_active = true
      RETURNING *
    `, [name, description, contractPlan, JSON.stringify(items), templateId]);
    return result.rows[0];
  }

  /**
   * テンプレート削除（論理削除）
   */
  static async deleteTemplate(templateId) {
    const result = await db.query(
      `UPDATE schedule_templates
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id`,
      [templateId]
    );
    return result.rows.length > 0;
  }

  static normalizeTemplateData(data) {
    return normalizeTemplateData(data);
  }
}

module.exports = LessonSchedule;
