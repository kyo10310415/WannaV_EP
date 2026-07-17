const cron = require('node-cron');
const User = require('../models/User');
const NotificationService = require('../utils/notification');
const db = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// 既存ジョブ: 不活発ユーザー通知 (毎日 10:00)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleInactiveUserReminders = () => {
  cron.schedule('0 10 * * *', async () => {
    console.log('🔔 Running inactive user check...');
    try {
      const inactiveUsers = await User.getUsersWithoutProgressForDays(3);
      if (inactiveUsers.length > 0) {
        console.log(`📧 Found ${inactiveUsers.length} inactive users`);
        await NotificationService.notifyInactiveUsers(inactiveUsers);
      } else {
        console.log('✅ All users are active!');
      }
    } catch (error) {
      console.error('❌ Error in inactive user check:', error);
    }
  });
  console.log('✅ Cron job scheduled: Daily inactive user reminders at 10:00 AM');
};

// ─────────────────────────────────────────────────────────────────────────────
// 既存ジョブ: Notion 同期 (毎日 02:00)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleNotionSync = () => {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    console.log('⏭️  Notion cron skipped: NOTION_TOKEN or NOTION_DATABASE_ID not set');
    return;
  }

  cron.schedule('0 2 * * *', async () => {
    console.log('🔄 [Cron] Notion daily sync starting...');
    try {
      const { syncNotionStudents } = require('./notionSync');
      const result = await syncNotionStudents();
      console.log(`✅ [Cron] Notion sync done: ${result.synced} records`);
    } catch (error) {
      console.error('❌ [Cron] Notion sync error:', error.message);
    }
  });
  console.log('✅ Cron job scheduled: Daily Notion sync at 02:00 AM');
};

// ─────────────────────────────────────────────────────────────────────────────
// 新規ジョブ: 契約期限警告通知 (毎日 09:00)
// 30日前・14日前・7日前の生徒を検出して Discord + DB 通知を送信
// ─────────────────────────────────────────────────────────────────────────────
const scheduleContractExpiryWarnings = () => {
  cron.schedule('0 9 * * *', async () => {
    console.log('📅 [Cron] Running contract expiry warning check...');
    try {
      const thresholds = [
        { days: 30, label: '30日前', color: 0x3498DB, emoji: '📅' },
        { days: 14, label: '14日前', color: 0xF39C12, emoji: '⚠️' },
        { days: 7,  label: '7日前',  color: 0xE74C3C, emoji: '🚨' },
      ];

      for (const threshold of thresholds) {
        // 今日から threshold.days 日後が契約終了日の生徒を取得
        const result = await db.query(`
          SELECT
            sp.user_id,
            u.username,
            u.email,
            sp.contract_end_date,
            sp.contract_plan,
            sp.status,
            COALESCE(tu.username, '') AS tutor_name,
            sp.assigned_tutor_id
          FROM student_profiles sp
          JOIN users u ON u.id = sp.user_id
          LEFT JOIN users tu ON tu.id = sp.assigned_tutor_id
          WHERE sp.status = 'アクティブ'
            AND sp.contract_end_date::date = (CURRENT_DATE + INTERVAL '${threshold.days} days')::date
        `);

        if (result.rows.length === 0) continue;

        console.log(`📋 Found ${result.rows.length} students expiring in ${threshold.days} days`);

        for (const student of result.rows) {
          // Discord 通知
          const embed = {
            title: `${threshold.emoji} 契約期限警告: ${threshold.label}`,
            description: `**${student.username}** さんの契約が **${threshold.days}日後** に終了します。`,
            color: threshold.color,
            fields: [
              { name: '📋 プラン', value: student.contract_plan || '未設定', inline: true },
              { name: '📅 契約終了日', value: student.contract_end_date
                  ? new Date(student.contract_end_date).toLocaleDateString('ja-JP')
                  : '未設定', inline: true },
              { name: '👨‍🏫 担当チューター', value: student.tutor_name || '未割当', inline: true },
            ],
            footer: { text: 'WannaV 受講管理システム' },
            timestamp: new Date().toISOString(),
          };

          await NotificationService.sendDiscordNotification(
            `${threshold.emoji} **契約期限警告 (${threshold.label})**`,
            embed
          );

          // DB 通知レコード保存 (read_at なし = 未読)
          try {
            await db.query(`
              INSERT INTO notifications
                (user_id, target_user_id, message, type, channel)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT DO NOTHING
            `, [
              student.assigned_tutor_id || student.user_id,
              student.user_id,
              `契約期限警告 (${threshold.label}): ${student.username} さんの契約が${threshold.days}日後に終了します`,
              'contract_expiry',
              'discord',
            ]);
          } catch (dbErr) {
            // notifications テーブルのカラム差異など — サイレント
            console.warn('⚠️  DB notification insert skipped:', dbErr.message);
          }

          // ActivityLog
          try {
            await db.query(`
              INSERT INTO activity_logs (user_id, action, target_type, target_id, detail)
              VALUES ($1, $2, $3, $4, $5)
            `, [
              null,
              'contract_expiry_warning',
              'student',
              student.user_id,
              JSON.stringify({ days: threshold.days, contract_end_date: student.contract_end_date }),
            ]);
          } catch (_) { /* サイレント */ }
        }
      }

      console.log('✅ [Cron] Contract expiry warning check done');
    } catch (error) {
      console.error('❌ [Cron] Contract expiry warning error:', error);
    }
  });

  console.log('✅ Cron job scheduled: Daily contract expiry warnings at 09:00 AM');
};

// ─────────────────────────────────────────────────────────────────────────────
// 新規ジョブ: 契約期限14日前の生徒に延長審査レコードを自動作成 (毎日 09:10)
// 既に審査中のレコードがある場合はスキップ
// ─────────────────────────────────────────────────────────────────────────────
const scheduleAutoCreateExtensionReviews = () => {
  cron.schedule('10 9 * * *', async () => {
    console.log('🔄 [Cron] Auto-creating extension review records...');
    try {
      // 契約終了まで14日以内かつ審査中レコードが存在しない アクティブ生徒
      const result = await db.query(`
        SELECT
          sp.user_id,
          u.username,
          sp.contract_end_date,
          sp.contract_plan,
          sp.assigned_tutor_id
        FROM student_profiles sp
        JOIN users u ON u.id = sp.user_id
        WHERE sp.status = 'アクティブ'
          AND sp.contract_end_date IS NOT NULL
          AND sp.contract_end_date::date <= (CURRENT_DATE + INTERVAL '14 days')::date
          AND sp.contract_end_date::date >= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM extension_reviews er
            WHERE er.student_user_id = sp.user_id
              AND er.review_status IN ('審査中', '保留')
          )
      `);

      if (result.rows.length === 0) {
        console.log('✅ [Cron] No new extension reviews needed');
        return;
      }

      console.log(`📝 [Cron] Auto-creating ${result.rows.length} extension review(s)...`);

      for (const student of result.rows) {
        // 延長審査レコード自動作成
        await db.query(`
          INSERT INTO extension_reviews
            (student_user_id, trigger_type, review_status, notes)
          VALUES ($1, $2, $3, $4)
        `, [
          student.user_id,
          'auto_expiry',   // trigger_type: 自動作成
          '審査中',
          `契約終了14日前の自動審査レコード (終了日: ${
            student.contract_end_date
              ? new Date(student.contract_end_date).toLocaleDateString('ja-JP')
              : '不明'
          })`,
        ]);

        // Discord 通知
        const embed = {
          title: '📝 延長審査レコード自動作成',
          description: `**${student.username}** さんの契約期限が近づいたため、延長審査レコードを自動作成しました。`,
          color: 0x9B59B6,
          fields: [
            { name: '📅 契約終了日', value: student.contract_end_date
                ? new Date(student.contract_end_date).toLocaleDateString('ja-JP')
                : '未設定', inline: true },
            { name: '📋 プラン', value: student.contract_plan || '未設定', inline: true },
          ],
          footer: { text: 'WannaV 受講管理システム — 自動生成' },
          timestamp: new Date().toISOString(),
        };

        await NotificationService.sendDiscordNotification(
          '📝 **延長審査レコード自動作成**',
          embed
        );

        // ActivityLog
        try {
          await db.query(`
            INSERT INTO activity_logs (user_id, action, target_type, target_id, detail)
            VALUES ($1, $2, $3, $4, $5)
          `, [
            null,
            'auto_create_extension_review',
            'student',
            student.user_id,
            JSON.stringify({ trigger: 'auto_expiry', contract_end_date: student.contract_end_date }),
          ]);
        } catch (_) { /* サイレント */ }
      }

      console.log('✅ [Cron] Auto extension review creation done');
    } catch (error) {
      console.error('❌ [Cron] Auto extension review creation error:', error);
    }
  });

  console.log('✅ Cron job scheduled: Auto extension review creation at 09:10 AM');
};

// ─────────────────────────────────────────────────────────────────────────────
// 新規ジョブ: アクティブ生徒の長期不活発検知 (毎日 10:05)
// 7日以上進捗なしのアクティブ生徒を検出して Discord + DB 通知
// (既存の 3日チェックとは別で アクティブ生徒専用)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleActiveStudentInactivityCheck = () => {
  cron.schedule('5 10 * * *', async () => {
    console.log('🔍 [Cron] Running active student inactivity check (7 days)...');
    try {
      // アクティブな生徒で最終進捗が7日以上前のユーザー
      const result = await db.query(`
        SELECT
          u.id,
          u.username,
          u.email,
          sp.assigned_tutor_id,
          COALESCE(tu.username, '') AS tutor_name,
          MAX(up.last_accessed) AS last_accessed,
          EXTRACT(DAY FROM NOW() - MAX(up.last_accessed)) AS inactive_days
        FROM users u
        JOIN student_profiles sp ON sp.user_id = u.id
        LEFT JOIN users tu ON tu.id = sp.assigned_tutor_id
        LEFT JOIN user_progress up ON up.user_id = u.id
        WHERE sp.status = 'アクティブ'
          AND u.role = '生徒'
        GROUP BY u.id, u.username, u.email, sp.assigned_tutor_id, tu.username
        HAVING MAX(up.last_accessed) IS NULL
            OR MAX(up.last_accessed) < NOW() - INTERVAL '7 days'
      `);

      if (result.rows.length === 0) {
        console.log('✅ [Cron] No long-term inactive active students found');
        return;
      }

      console.log(`⚠️  [Cron] Found ${result.rows.length} long-term inactive active student(s)`);

      for (const student of result.rows) {
        const inactiveDays = student.inactive_days !== null
          ? Math.floor(Number(student.inactive_days))
          : '不明';

        const embed = {
          title: '⚠️ アクティブ生徒 長期不活発検知',
          description: `**${student.username}** さん (アクティブ) が **${inactiveDays}日間** 学習していません。`,
          color: 0xE67E22,
          fields: [
            { name: '⏰ 最終学習', value: student.last_accessed
                ? new Date(student.last_accessed).toLocaleDateString('ja-JP')
                : '記録なし', inline: true },
            { name: '👨‍🏫 担当チューター', value: student.tutor_name || '未割当', inline: true },
            { name: '📋 推奨アクション', value: '担当チューターからのフォローアップを検討してください', inline: false },
          ],
          footer: { text: 'WannaV 受講管理システム' },
          timestamp: new Date().toISOString(),
        };

        await NotificationService.sendDiscordNotification(
          '⚠️ **アクティブ生徒 長期不活発検知 (7日以上)**',
          embed
        );

        // DB 通知
        try {
          await db.query(`
            INSERT INTO notifications
              (user_id, target_user_id, message, type, channel)
            VALUES ($1, $2, $3, $4, $5)
          `, [
            student.assigned_tutor_id || student.id,
            student.id,
            `長期不活発警告: ${student.username} さんが${inactiveDays}日間学習していません`,
            'inactivity_warning',
            'discord',
          ]);
        } catch (_) { /* サイレント */ }

        // ActivityLog
        try {
          await db.query(`
            INSERT INTO activity_logs (user_id, action, target_type, target_id, detail)
            VALUES ($1, $2, $3, $4, $5)
          `, [
            null,
            'long_term_inactivity_detected',
            'student',
            student.id,
            JSON.stringify({ inactive_days: inactiveDays, last_accessed: student.last_accessed }),
          ]);
        } catch (_) { /* サイレント */ }
      }

      console.log('✅ [Cron] Active student inactivity check done');
    } catch (error) {
      console.error('❌ [Cron] Active student inactivity check error:', error);
    }
  });

  console.log('✅ Cron job scheduled: Active student inactivity check (7-day) at 10:05 AM');
};

// ─────────────────────────────────────────────────────────────────────────────
// 新規ジョブ: 古いアクティビティログの自動削除 (毎週日曜日 03:00)
// デフォルト保持期間: 90日
// ─────────────────────────────────────────────────────────────────────────────
const scheduleLogCleanup = () => {
  const daysToKeep = parseInt(process.env.LOG_RETENTION_DAYS || '90', 10);

  cron.schedule('0 3 * * 0', async () => {
    console.log(`🧹 [Cron] Cleaning activity logs older than ${daysToKeep} days...`);
    try {
      const result = await db.query(`
        DELETE FROM activity_logs
        WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
      `);
      console.log(`✅ [Cron] Deleted ${result.rowCount} old activity log(s)`);
    } catch (error) {
      console.error('❌ [Cron] Log cleanup error:', error);
    }
  });

  console.log(`✅ Cron job scheduled: Weekly activity log cleanup (keep ${daysToKeep} days) on Sunday 03:00`);
};

// ─────────────────────────────────────────────────────────────────────────────
// 全ジョブ一括起動
// ─────────────────────────────────────────────────────────────────────────────
const startAllSchedulers = () => {
  scheduleInactiveUserReminders();
  scheduleNotionSync();
  scheduleContractExpiryWarnings();
  scheduleAutoCreateExtensionReviews();
  scheduleActiveStudentInactivityCheck();
  scheduleLogCleanup();
  console.log('🚀 All cron jobs registered');
};

module.exports = {
  scheduleInactiveUserReminders,
  scheduleNotionSync,
  scheduleContractExpiryWarnings,
  scheduleAutoCreateExtensionReviews,
  scheduleActiveStudentInactivityCheck,
  scheduleLogCleanup,
  startAllSchedulers,
};
