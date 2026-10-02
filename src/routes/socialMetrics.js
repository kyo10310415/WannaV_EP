const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const db = require('../config/database');
const { SocialMetrics, accountKey, validId } = require('../models/SocialMetrics');

// Only the explicitly designated, Notion-unlinked test student accepts manual IDs.
async function testStudent() {
  return (await db.query(`SELECT u.id, a.x_username, a.youtube_channel_id FROM users u
    LEFT JOIN test_student_social_accounts a ON a.user_id = u.id
    WHERE u.username = 'test_seito' AND u.role = '生徒'
      AND NOT EXISTS (SELECT 1 FROM student_profiles sp WHERE sp.user_id = u.id AND sp.notion_page_id IS NOT NULL)`)).rows[0];
}

router.get('/test-account', auth, checkRole('管理者'), async (req, res) => {
  try {
    const student = await testStudent();
    if (!student) return res.status(404).json({ error: 'Notion未連携のtest_seitoが見つかりません' });
    res.set('Cache-Control', 'private, no-store');
    res.json({ xUsername: student.x_username || '', youtubeChannelId: student.youtube_channel_id || '' });
  } catch (_) { res.status(500).json({ error: 'SNS設定の取得に失敗しました' }); }
});

router.put('/test-account', auth, checkRole('管理者'), async (req, res) => {
  const { xUsername, youtubeChannelId } = req.body || {};
  if (typeof xUsername !== 'string' || typeof youtubeChannelId !== 'string') {
    return res.status(400).json({ error: 'SNS IDを文字列で指定してください' });
  }
  const x = accountKey('x', xUsername), youtube = accountKey('youtube', youtubeChannelId);
  if ((x && !validId('x', x)) || (youtube && !validId('youtube', youtube))) {
    return res.status(400).json({ error: 'XはIDのみ、YouTubeはUCから始まるチャンネルIDを入力してください' });
  }
  try {
    const student = await testStudent();
    if (!student) return res.status(404).json({ error: 'Notion未連携のtest_seitoが見つかりません' });
    await db.query(`INSERT INTO test_student_social_accounts(notion_page_id,user_id,x_username,youtube_channel_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET
        x_username = EXCLUDED.x_username, youtube_channel_id = EXCLUDED.youtube_channel_id`,
    ['manual:' + student.id, student.id, x || null, youtube || null]);
    void SocialMetrics.synchronize().catch(() => console.error('Test account SNS synchronization failed'));
    res.json({ message: 'SNS IDを保存しました。未取得の今週データを取得します。' });
  } catch (_) { res.status(500).json({ error: 'SNS設定の保存に失敗しました' }); }
});

router.get('/me', auth, checkRole('生徒'), async (req, res) => {
  try {
    const profile = (await db.query('SELECT notion_page_id FROM student_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: profile?.notion_page_id ? await SocialMetrics.forPage(profile.notion_page_id) : await SocialMetrics.forUser(req.user.id) });
  } catch (_) {
    res.status(500).json({ error: 'SNSデータの取得に失敗しました' });
  }
});

router.get('/student', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const { notionPageId, userId } = req.query;
    if ((Boolean(notionPageId) === Boolean(userId)) ||
        (notionPageId && (typeof notionPageId !== 'string' || notionPageId.length > 255)) ||
        (userId && (typeof userId !== 'string' || !/^[1-9]\d*$/.test(userId) || Number(userId) > 2147483647))) {
      return res.status(400).json({ error: '生徒を正しく指定してください' });
    }
    const result = notionPageId
      ? await db.query(`SELECT ns.notion_page_id, sp.assigned_tutor_id
          FROM notion_students ns LEFT JOIN student_profiles sp ON sp.notion_page_id = ns.notion_page_id
          WHERE ns.notion_page_id = $1`, [notionPageId])
      : await db.query(`SELECT sp.notion_page_id, sp.assigned_tutor_id FROM users u
          LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1 AND u.role = '生徒'`, [userId]);
    if (!result.rows.length) return res.status(404).json({ error: '生徒が見つかりません' });
    if (req.user.role === 'クルー' && !result.rows.some(row => Number(row.assigned_tutor_id) === Number(req.user.id))) {
      return res.status(403).json({ error: '担当生徒のみ閲覧できます' });
    }
    const pageId = result.rows[0].notion_page_id;
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: pageId ? await SocialMetrics.forPage(pageId) : userId ? await SocialMetrics.forUser(userId) : null });
  } catch (_) {
    res.status(500).json({ error: 'SNSデータの取得に失敗しました' });
  }
});

module.exports = router;
