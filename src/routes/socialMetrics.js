const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const db = require('../config/database');
const { SocialMetrics } = require('../models/SocialMetrics');

router.get('/me', auth, checkRole('生徒'), async (req, res) => {
  try {
    const profile = (await db.query('SELECT notion_page_id FROM student_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: profile?.notion_page_id ? await SocialMetrics.forPage(profile.notion_page_id) : null });
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
    res.json({ data: pageId ? await SocialMetrics.forPage(pageId) : null });
  } catch (_) {
    res.status(500).json({ error: 'SNSデータの取得に失敗しました' });
  }
});

module.exports = router;
