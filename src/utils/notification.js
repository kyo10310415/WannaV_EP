const axios = require('axios');
const db = require('../config/database');

class NotificationService {
  static async sendDiscordNotification(message, embed = null) {
    try {
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      
      if (!webhookUrl) {
        console.warn('⚠️  Discord webhook URL not configured');
        return;
      }

      const payload = {
        content: message,
        username: 'WannaV Learning Bot',
        avatar_url: 'https://i.imgur.com/4M34hi2.png' // VTuberアイコン（後で変更可能）
      };

      if (embed) {
        payload.embeds = [embed];
      }

      await axios.post(webhookUrl, payload);
      console.log('✅ Discord notification sent');
    } catch (error) {
      console.error('❌ Error sending Discord notification:', error.message);
    }
  }

  static async notifyInactiveUsers(users) {
    for (const user of users) {
      const message = `🔔 **進捗リマインダー**`;
      const embed = {
        title: '学習の進捗はどうですか？',
        description: `${user.name}さん、最近学習が進んでいないようです...`,
        color: 0xFF6B9D, // VTuberピンク
        fields: [
          {
            name: '⚠️ このままだと...',
            value: '他の受講生に差をつけられてしまうかもしれません！\n今すぐレッスンを再開して、目標達成に近づきましょう！'
          },
          {
            name: '🎯 あなたならできる！',
            value: 'VTuberとしての夢を叶えるため、一緒に頑張りましょう！'
          }
        ],
        footer: {
          text: 'WannaV eラーニング - あなたの成長をサポートします'
        },
        timestamp: new Date().toISOString()
      };

      await this.sendDiscordNotification(message, embed);

      // Log notification
      await db.query(
        'INSERT INTO notifications (user_id, message, type) VALUES ($1, $2, $3)',
        [user.id, `進捗リマインダー送信: ${user.name}`, 'reminder']
      );
    }
  }

  static async celebrateCompletion(userName, lessonTitle) {
    const message = `🎉 **おめでとうございます！**`;
    const embed = {
      title: '✨ レッスン完了！',
      description: `**${userName}**さんが「${lessonTitle}」を完了しました！`,
      color: 0xFFD700, // ゴールド
      fields: [
        {
          name: '🌟 素晴らしい！',
          value: 'クイズも全問正解です！この調子で次のレッスンも頑張りましょう！'
        }
      ],
      thumbnail: {
        url: 'https://i.imgur.com/AfFp7pu.png' // 祝福アイコン
      },
      footer: {
        text: 'WannaV eラーニング'
      },
      timestamp: new Date().toISOString()
    };

    await this.sendDiscordNotification(message, embed);
  }
}

module.exports = NotificationService;
