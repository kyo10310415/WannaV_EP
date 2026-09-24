const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const PortalSetting = require('../models/PortalSetting');
const ImportantMessage = require('../models/ImportantMessage');
const { getUpcomingPortalDates } = require('../utils/recurringDates');

router.get('/important-message', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ message: await ImportantMessage.getVisibleFor(req.user.id) });
  } catch (error) {
    console.error('Get important message error:', error);
    res.status(500).json({ error: '重要メッセージの取得に失敗しました' });
  }
});

router.post('/important-message/dismiss', auth, async (req, res) => {
  try {
    const revision = req.body?.revision;
    if (!Number.isInteger(revision) || revision < 1) {
      return res.status(400).json({ error: 'メッセージの版が不正です' });
    }
    if (!await ImportantMessage.dismissToday(req.user.id, revision)) {
      return res.status(409).json({ error: 'メッセージが更新されました。画面を開き直してください' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss important message error:', error);
    res.status(500).json({ error: '「本日は表示しない」の保存に失敗しました' });
  }
});

router.get('/links', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const links = await PortalSetting.getLinks();
    const dates = getUpcomingPortalDates();
    res.json({
      bucchakeVtuber: {
        title: 'ぶっちゃけVtuber',
        url: links.bucchakeVtuberUrl,
        schedule: '第一、第三金曜日の22時から',
        nextDate: dates.bucchakeVtuber,
      },
      classLesson: {
        title: 'クラスレッスン',
        url: links.classLessonUrl,
        schedule: '第二、第四水曜日の22時から',
        nextDate: dates.classLesson,
      },
    });
  } catch (error) {
    console.error('Get portal links error:', error);
    res.status(500).json({ error: '案内リンクの取得に失敗しました' });
  }
});

module.exports = router;
