const db = require('../config/database');

class LessonSchedule {
  // =====================================================
  // スケジュール作成・更新
  // =====================================================

  /**
   * スケジュールを1件作成
   */
  static async create(data) {
    const {
      userId, lessonId, scheduledDate, dueDate,
      orderInSchedule, priority, tutorNote, createdBy
    } = data;

    const result = await db.query(`
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
    const tRes = await db.query(
      'SELECT * FROM schedule_templates WHERE id = $1',
      [templateId]
    );
    const template = tRes.rows[0];
    if (!template) throw new Error('テンプレートが見つかりません');

    const items = template.items || [];
    const base = new Date(startDate);
    const created = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const schedDate = new Date(base);
      schedDate.setDate(schedDate.getDate() + (item.dayOffset || i * 2));
      const dueDate = item.dueOffset
        ? new Date(schedDate.getTime() + item.dueOffset * 86400000)
        : null;

      try {
        const row = await LessonSchedule.create({
          userId,
          lessonId: item.lessonId,
          scheduledDate: schedDate.toISOString().split('T')[0],
          dueDate: dueDate ? dueDate.toISOString().split('T')[0] : null,
          orderInSchedule: i,
          priority: item.priority || 0,
          tutorNote: item.note || null,
          createdBy
        });
        created.push(row);
      } catch (e) {
        // 個別エラーはスキップ（重複など）
        console.warn('Schedule create skip:', e.message);
      }
    }
    return created;
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
   * 担当Tutorの全生徒スケジュール概況
   */
  static async getOverviewForTutor(tutorId) {
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
      LEFT JOIN lesson_schedules ls ON u.id = ls.user_id
      WHERE sp.assigned_tutor_id = $1 AND u.role = '生徒'
      GROUP BY u.id, u.name, u.username
      ORDER BY overdue DESC, next_lesson_date ASC NULLS LAST
    `, [tutorId]);
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
      SELECT st.*, u.name AS created_by_name,
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
    const { name, description, contractPlan, items, createdBy } = data;
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
    const { name, description, contractPlan, items, isActive } = data;
    const result = await db.query(`
      UPDATE schedule_templates SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        contract_plan = COALESCE($3, contract_plan),
        items = COALESCE($4, items),
        is_active = COALESCE($5, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [name||null, description||null, contractPlan||null,
        items ? JSON.stringify(items) : null,
        isActive !== undefined ? isActive : null,
        templateId]);
    return result.rows[0];
  }

  /**
   * テンプレート削除（論理削除）
   */
  static async deleteTemplate(templateId) {
    await db.query(
      'UPDATE schedule_templates SET is_active = false WHERE id = $1',
      [templateId]
    );
  }
}

module.exports = LessonSchedule;
