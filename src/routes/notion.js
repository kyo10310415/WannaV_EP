const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const NotionStudent = require('../models/NotionStudent');
const { syncNotionStudents, fetchDatabaseProperties } = require('../utils/notionSync');

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
    if (error.message.includes('NOTION_TOKEN') || error.message.includes('DATABASE_ID')) {
      return res.status(503).json({
        error: 'Notion の設定が不完全です。NOTION_TOKEN と NOTION_DATABASE_ID を確認してください。',
        detail: error.message
      });
    }
    res.status(500).json({ error: 'Notion 同期に失敗しました', detail: error.message });
  }
});

/**
 * GET /api/notion/debug-props
 * Notion DB のプロパティ名・型・選択肢を返す（プロパティ名確認用デバッグ API）
 * 管理者のみアクセス可
 */
router.get('/debug-props', auth, checkRole('管理者'), async (req, res) => {
  try {
    const result = await fetchDatabaseProperties();
    res.json({
      dbTitle: result.dbTitle,
      schema: result.schema,
      sampleValues: result.sampleValues,
      hint: '上記 name がプロパティ名です。notionSync.js の PROP オブジェクトと一致させてください。'
    });
  } catch (error) {
    console.error('Debug props error:', error);
    const detail = error.response
      ? `Notion API ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    res.status(500).json({ error: 'プロパティ取得に失敗しました', detail });
  }
});

/**
 * GET /api/notion/debug-raw
 * DBキャッシュの raw_data から実際のプロパティキー名を返す（同期済みデータから確認）
 * 管理者のみアクセス可
 */
router.get('/debug-raw', auth, checkRole('管理者'), async (req, res) => {
  try {
    const db = require('../config/database');
    const result = await db.query(
      'SELECT raw_data FROM notion_students LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.json({ message: 'DBにデータがありません。まず同期を実行してください。' });
    }

    const raw = result.rows[0].raw_data;
    const props = raw?.properties || {};

    // プロパティ名と型、値を整理して返す
    const propList = Object.entries(props).map(([key, val]) => {
      // 値のプレビューを生成
      let preview = null;
      try {
        if (val.type === 'title')       preview = val.title?.map(t => t.plain_text).join('');
        else if (val.type === 'rich_text') preview = val.rich_text?.map(t => t.plain_text).join('');
        else if (val.type === 'select')    preview = val.select?.name;
        else if (val.type === 'multi_select') preview = val.multi_select?.map(s => s.name).join(', ');
        else if (val.type === 'date')      preview = val.date?.start;
        else if (val.type === 'number')    preview = String(val.number ?? '');
        else if (val.type === 'url')       preview = val.url;
        else if (val.type === 'formula')   preview = val.formula?.string ?? String(val.formula?.number ?? '');
      } catch(e) { preview = '(parse error)'; }

      return { name: key, type: val.type, preview: preview || '(空)' };
    });

    res.json({
      message: '以下が実際の Notion プロパティ名です。notionSync.js の PROP オブジェクトと照合してください。',
      properties: propList
    });
  } catch (error) {
    console.error('Debug raw error:', error);
    res.status(500).json({ error: 'raw_data の取得に失敗しました', detail: error.message });
  }
});

module.exports = router;
