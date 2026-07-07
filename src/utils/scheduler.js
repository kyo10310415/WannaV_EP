const cron = require('node-cron');
const User = require('../models/User');
const NotificationService = require('../utils/notification');

// 毎日午前10時に実行（日本時間の場合は調整が必要）
const scheduleInactiveUserReminders = () => {
  // 毎日10:00に実行
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

/**
 * Notion 生徒データを毎日 2:00 AM に自動同期するクロンジョブ
 * NOTION_TOKEN と NOTION_DATABASE_ID が設定されていない場合はスキップ
 */
const scheduleNotionSync = () => {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    console.log('⏭️  Notion cron skipped: NOTION_TOKEN or NOTION_DATABASE_ID not set');
    return;
  }

  // 毎日 02:00 に実行（サーバー時刻）
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

module.exports = { scheduleInactiveUserReminders, scheduleNotionSync };
