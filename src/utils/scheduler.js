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

module.exports = { scheduleInactiveUserReminders };
