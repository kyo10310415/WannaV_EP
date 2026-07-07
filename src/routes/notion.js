const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const NotionStudent = require('../models/NotionStudent');
const { syncNotionStudents } = require('../utils/notionSync');

/**
 * GET /api/notion/students
 * エントリープランの生徒一覧を返す（DBキャッシュから）
 */
router.get('/students', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const students = await NotionStudent.getAll();
    const lastSynced = await NotionStudent.getLastSyncedAt();
    res.json({ students, lastSynced });
  } catch (error) {
    console.error('Get notion students error:', error);
    res.status(500).json({ error: '生徒データの取得に失敗しました' });
  }
});

/**
 * POST /api/notion/sync
 * 手動で Notion から最新データを同期する（管理者のみ）
 */
router.post('/sync', auth, checkRole('管理者'), async (req, res) => {
  try {
    const result = await syncNotionStudents();
    res.json({
      success: true,
      message: `${result.synced} 件のデータを同期しました`,
      synced: result.synced,
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('Notion sync error:', error);
    // 設定ミスか一時的なエラーかを区別
    if (error.message.includes('NOTION_TOKEN') || error.message.includes('DATABASE_ID')) {
      return res.status(503).json({
        error: 'Notion の設定が不完全です。NOTION_TOKEN と NOTION_DATABASE_ID を確認してください。',
        detail: error.message
      });
    }
    res.status(500).json({ error: 'Notion 同期に失敗しました', detail: error.message });
  }
});

module.exports = router;
